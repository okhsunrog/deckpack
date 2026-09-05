//! Service reservations: wiring exits and harness volumes attached to a
//! pack face.

use crate::types::{PackFace, PackRequest, ServiceKind, ServiceReservation, Vec3, WiringExitMode};

pub const COMBINED_WIRING_EXIT_ID: &str = "wiring-exit";
pub const POWER_OUTPUT_ID: &str = "power-output";
pub const BALANCE_HARNESS_ID: &str = "balance-harness";

pub fn default_service_reservations() -> Vec<ServiceReservation> {
    vec![
        ServiceReservation {
            id: COMBINED_WIRING_EXIT_ID.into(),
            label: "Силовые + балансировка".into(),
            kind: ServiceKind::WiringExit,
            face: PackFace::NegativeX,
            size_mm: [60.0, 34.0, 18.0],
            offset_mm: Some([0.0, 0.0, 0.0]),
            enabled: true,
        },
        ServiceReservation {
            id: POWER_OUTPUT_ID.into(),
            label: "Силовые провода".into(),
            kind: ServiceKind::PowerOutput,
            face: PackFace::NegativeX,
            size_mm: [45.0, 34.0, 18.0],
            offset_mm: Some([0.0, -9.0, 0.0]),
            enabled: true,
        },
        ServiceReservation {
            id: BALANCE_HARNESS_ID.into(),
            label: "Балансировочный шлейф".into(),
            kind: ServiceKind::BalanceHarness,
            face: PackFace::NegativeX,
            size_mm: [60.0, 14.0, 12.0],
            offset_mm: Some([0.0, 19.0, 0.0]),
            enabled: true,
        },
    ]
}

/// Reservations that apply under the current wiring-exit mode.
pub fn active_service_reservations(
    pack: &PackRequest,
) -> impl Iterator<Item = &ServiceReservation> {
    pack.service_reservations
        .iter()
        .filter(move |reservation| match pack.wiring_exit_mode {
            WiringExitMode::Combined => reservation.kind == ServiceKind::WiringExit,
            WiringExitMode::Separate => reservation.kind != ServiceKind::WiringExit,
        })
}

/// Side-by-side offsets for the split power / balance reservations.
pub fn separated_offsets(
    face: PackFace,
    power: &ServiceReservation,
    balance: &ServiceReservation,
    gap_mm: f64,
) -> (Vec3, Vec3) {
    let tangent = if face.axis() == crate::types::Axis::X {
        1
    } else {
        0
    };
    let mut power_offset = [0.0; 3];
    let mut balance_offset = [0.0; 3];
    power_offset[tangent] = -(balance.size_mm[tangent] + gap_mm) / 2.0;
    balance_offset[tangent] = (power.size_mm[tangent] + gap_mm) / 2.0;
    (power_offset, balance_offset)
}

/// Switch between one combined exit and separate power / balance exits,
/// carrying the enabled state and face across.
pub fn set_wiring_exit_mode(pack: &PackRequest, mode: WiringExitMode) -> PackRequest {
    if mode == pack.wiring_exit_mode {
        return pack.clone();
    }
    let find = |kind: ServiceKind| pack.service_reservations.iter().find(|r| r.kind == kind);
    let (Some(combined), Some(power), Some(balance)) = (
        find(ServiceKind::WiringExit),
        find(ServiceKind::PowerOutput),
        find(ServiceKind::BalanceHarness),
    ) else {
        return PackRequest {
            wiring_exit_mode: mode,
            ..pack.clone()
        };
    };

    let reservations = match mode {
        WiringExitMode::Combined => pack
            .service_reservations
            .iter()
            .map(|reservation| {
                if reservation.id != combined.id {
                    return reservation.clone();
                }
                ServiceReservation {
                    enabled: power.enabled || balance.enabled,
                    face: if power.face == balance.face {
                        power.face
                    } else {
                        combined.face
                    },
                    offset_mm: Some([0.0; 3]),
                    ..reservation.clone()
                }
            })
            .collect(),
        WiringExitMode::Separate => {
            let (power_offset, balance_offset) =
                separated_offsets(combined.face, power, balance, 4.0);
            pack.service_reservations
                .iter()
                .map(|reservation| {
                    let offset = if reservation.id == power.id {
                        power_offset
                    } else if reservation.id == balance.id {
                        balance_offset
                    } else {
                        return reservation.clone();
                    };
                    ServiceReservation {
                        enabled: combined.enabled,
                        face: combined.face,
                        offset_mm: Some(offset),
                        ..reservation.clone()
                    }
                })
                .collect()
        }
    };
    PackRequest {
        wiring_exit_mode: mode,
        service_reservations: reservations,
        ..pack.clone()
    }
}
