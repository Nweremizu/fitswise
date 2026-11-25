//! Asks Windows about the buds without ever touching them.
//!
//! "Connected" means Windows exposes an audio output whose container id matches the paired buds.
//! That stays true only while Windows itself is using them, so our own RFCOMM link can never
//! make the buds look connected.

use std::sync::mpsc::Sender;
use windows::Devices::Bluetooth::BluetoothDevice;
use windows::Devices::Enumeration::{DeviceInformation, DeviceInformationUpdate, DeviceWatcher};
use windows::Devices::Radios::{Radio, RadioKind, RadioState};
use windows::Foundation::{IPropertyValue, TypedEventHandler};
use windows::Media::Devices::MediaDevice;
use windows::core::{GUID, HSTRING, Interface, Result};
use windows_collections::IIterable;

const VENDOR_APPLE: u32 = 0x004c;
const FIT_PRO: u32 = 0x2012;
const CONTAINER: &str = "System.Devices.ContainerId";
const AEP_CONTAINER: &str = "System.Devices.Aep.ContainerId";
const AEP_ADDRESS: &str = "System.Devices.Aep.DeviceAddress";

pub enum Wake {
    /// Windows reported an audio or Bluetooth device change.
    Windows,
    /// The link to the buds closed.
    Closed,
    /// A report was incomplete; ask again shortly.
    Incomplete,
    /// The buds turned noise control off by themselves.
    SwitchedOff,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Presence {
    BluetoothOff,
    NotPaired,
    /// Apple or Beats audio is paired, but it isn't a Fit Pro.
    Unsupported,
    Disconnected,
    Connected(u64),
}

struct Paired {
    address: u64,
    container: GUID,
    name: String,
}

fn wanted(names: &[&str]) -> IIterable<HSTRING> {
    let v: Vec<HSTRING> = names.iter().map(|n| HSTRING::from(*n)).collect();
    v.into()
}

fn prop(d: &DeviceInformation, key: &str) -> Option<IPropertyValue> {
    d.Properties()
        .ok()?
        .Lookup(&HSTRING::from(key))
        .ok()?
        .cast()
        .ok()
}

fn paired() -> Result<Vec<Paired>> {
    let sel = BluetoothDevice::GetDeviceSelectorFromPairingState(true)?;
    let found = DeviceInformation::FindAllAsyncAqsFilterAndAdditionalProperties(
        &sel,
        &wanted(&[AEP_CONTAINER, AEP_ADDRESS]),
    )?
    .join()?;
    Ok(found
        .into_iter()
        .filter_map(|d| {
            let text = prop(&d, AEP_ADDRESS)?
                .GetString()
                .ok()?
                .to_string()
                .replace(':', "");
            Some(Paired {
                address: u64::from_str_radix(&text, 16).ok()?,
                container: prop(&d, AEP_CONTAINER)?.GetGuid().ok()?,
                name: d.Name().ok()?.to_string(),
            })
        })
        .collect())
}

/// Vendor and product id that Windows cached when the device was paired.
fn model(address: u64) -> Option<(u32, u32)> {
    let path =
        format!(r"SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices\{address:012x}");
    let key = windows_registry::LOCAL_MACHINE.open(path).ok()?;
    Some((key.get_u32("VID").ok()?, key.get_u32("PID").ok()?))
}

fn radio_on() -> bool {
    let Ok(Ok(radios)) = Radio::GetRadiosAsync().map(|op| op.join()) else {
        return true; // cannot tell: let the other checks decide
    };
    radios
        .into_iter()
        .any(|r| r.Kind() == Ok(RadioKind::Bluetooth) && r.State() == Ok(RadioState::On))
}

fn audio_containers() -> Result<Vec<GUID>> {
    let sel = MediaDevice::GetAudioRenderSelector()?;
    let found = DeviceInformation::FindAllAsyncAqsFilterAndAdditionalProperties(
        &sel,
        &wanted(&[CONTAINER]),
    )?
    .join()?;
    Ok(found
        .into_iter()
        .filter_map(|d| prop(&d, CONTAINER)?.GetGuid().ok())
        .collect())
}

pub fn presence() -> Presence {
    if !radio_on() {
        return Presence::BluetoothOff;
    }
    let Ok(paired) = paired() else {
        return Presence::NotPaired;
    };
    let (mut fit_pro, mut other) = (Vec::new(), false);
    for p in paired {
        match model(p.address) {
            Some((VENDOR_APPLE, FIT_PRO)) => fit_pro.push(p),
            Some((VENDOR_APPLE, _)) => other |= p.name.contains("Beats"),
            _ => {}
        }
    }
    if fit_pro.is_empty() {
        return if other {
            Presence::Unsupported
        } else {
            Presence::NotPaired
        };
    }
    let audio = audio_containers().unwrap_or_default();
    // ponytail: the first connected pair wins; add a picker if someone owns two
    match fit_pro.iter().find(|p| audio.contains(&p.container)) {
        Some(p) => Presence::Connected(p.address),
        None => Presence::Disconnected,
    }
}

/// Pokes `wake` whenever an audio output or a paired device appears, changes or goes.
/// Keep the returned watchers alive.
pub fn watch(wake: &Sender<Wake>) -> Result<Vec<DeviceWatcher>> {
    let selectors = [
        MediaDevice::GetAudioRenderSelector()?,
        BluetoothDevice::GetDeviceSelectorFromPairingState(true)?,
    ];
    selectors
        .iter()
        .map(|sel| {
            let w = DeviceInformation::CreateWatcherAqsFilter(sel)?;
            let tx = wake.clone();
            w.Added(&TypedEventHandler::new(
                move |_, _: windows::core::Ref<DeviceInformation>| {
                    let _ = tx.send(Wake::Windows);
                    Ok(())
                },
            ))?;
            for kind in 0..2 {
                let tx = wake.clone();
                let h = TypedEventHandler::new(
                    move |_, _: windows::core::Ref<DeviceInformationUpdate>| {
                        let _ = tx.send(Wake::Windows);
                        Ok(())
                    },
                );
                if kind == 0 {
                    w.Updated(&h)?;
                } else {
                    w.Removed(&h)?;
                }
            }
            w.Start()?;
            Ok(w)
        })
        .collect()
}
