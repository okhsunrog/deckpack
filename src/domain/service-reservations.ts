import type { PackFace, PackRequest, ServiceReservation, Vec3, WiringExitMode } from "./types";

export const COMBINED_WIRING_EXIT_ID = "wiring-exit";
export const POWER_OUTPUT_ID = "power-output";
export const BALANCE_HARNESS_ID = "balance-harness";

export function createDefaultServiceReservations(): ServiceReservation[] {
  return [
    {
      id: COMBINED_WIRING_EXIT_ID,
      label: "Силовые + балансировка",
      kind: "wiring-exit",
      face: "negative-x",
      sizeMm: [60, 34, 18],
      offsetMm: [0, 0, 0],
      enabled: true,
    },
    {
      id: POWER_OUTPUT_ID,
      label: "Силовые провода",
      kind: "power-output",
      face: "negative-x",
      sizeMm: [45, 34, 18],
      offsetMm: [0, -9, 0],
      enabled: true,
    },
    {
      id: BALANCE_HARNESS_ID,
      label: "Балансировочный шлейф",
      kind: "balance-harness",
      face: "negative-x",
      sizeMm: [60, 14, 12],
      offsetMm: [0, 19, 0],
      enabled: true,
    },
  ];
}

function sameVector(left?: Vec3, right?: Vec3): boolean {
  return (left ?? [0, 0, 0]).every(
    (value, axis) => Math.abs(value - (right ?? [0, 0, 0])[axis]) < 0.05,
  );
}

function combinedFromLegacy(reservations: ServiceReservation[]): ServiceReservation {
  const defaults = createDefaultServiceReservations()[0];
  const legacy = reservations.filter((reservation) => reservation.kind !== "wiring-exit");
  if (legacy.length === 0) return defaults;
  const sharedFace = legacy.every((reservation) => reservation.face === legacy[0].face);
  const sharedOffset = legacy.every((reservation) =>
    sameVector(reservation.offsetMm, legacy[0].offsetMm),
  );
  return {
    ...defaults,
    face: sharedFace ? legacy[0].face : defaults.face,
    sizeMm: [0, 1, 2].map((axis) =>
      Math.max(...legacy.map((reservation) => reservation.sizeMm[axis])),
    ) as Vec3,
    offsetMm: sharedOffset ? [...(legacy[0].offsetMm ?? [0, 0, 0])] : [0, 0, 0],
    enabled: legacy.some((reservation) => reservation.enabled),
  };
}

type PossiblyLegacyPack = Omit<PackRequest, "wiringExitMode"> & {
  wiringExitMode?: WiringExitMode;
};

export function normalizeWiringReservations(pack: PossiblyLegacyPack): PackRequest {
  const defaults = createDefaultServiceReservations();
  const reservations = pack.serviceReservations ?? [];
  const combined =
    reservations.find((reservation) => reservation.kind === "wiring-exit") ??
    combinedFromLegacy(reservations);
  const power =
    reservations.find((reservation) => reservation.kind === "power-output") ?? defaults[1];
  const balance =
    reservations.find((reservation) => reservation.kind === "balance-harness") ?? defaults[2];
  const legacySharesExit =
    power.face === balance.face && sameVector(power.offsetMm, balance.offsetMm);

  return {
    ...pack,
    wiringExitMode: pack.wiringExitMode ?? (legacySharesExit ? "combined" : "separate"),
    serviceReservations: [combined, power, balance],
  };
}

export function activeServiceReservations(pack: PackRequest): ServiceReservation[] {
  return pack.serviceReservations.filter((reservation) =>
    pack.wiringExitMode === "combined"
      ? reservation.kind === "wiring-exit"
      : reservation.kind !== "wiring-exit",
  );
}

export function separatedOffsets(
  face: PackFace,
  power: ServiceReservation,
  balance: ServiceReservation,
  gapMm = 4,
): { power: Vec3; balance: Vec3 } {
  const tangentAxis = face.endsWith("x") ? 1 : 0;
  const powerOffset: Vec3 = [0, 0, 0];
  const balanceOffset: Vec3 = [0, 0, 0];
  powerOffset[tangentAxis] = -(balance.sizeMm[tangentAxis] + gapMm) / 2;
  balanceOffset[tangentAxis] = (power.sizeMm[tangentAxis] + gapMm) / 2;
  return { power: powerOffset, balance: balanceOffset };
}

export function setWiringExitMode(pack: PackRequest, mode: WiringExitMode): PackRequest {
  if (mode === pack.wiringExitMode) return pack;
  const combined = pack.serviceReservations.find(
    (reservation) => reservation.kind === "wiring-exit",
  );
  const power = pack.serviceReservations.find((reservation) => reservation.kind === "power-output");
  const balance = pack.serviceReservations.find(
    (reservation) => reservation.kind === "balance-harness",
  );
  if (!combined || !power || !balance) return { ...pack, wiringExitMode: mode };

  if (mode === "combined") {
    return {
      ...pack,
      wiringExitMode: mode,
      serviceReservations: pack.serviceReservations.map((reservation) =>
        reservation.id === combined.id
          ? {
              ...reservation,
              enabled: power.enabled || balance.enabled,
              face: power.face === balance.face ? power.face : combined.face,
              offsetMm: [0, 0, 0],
            }
          : reservation,
      ),
    };
  }

  const offsets = separatedOffsets(combined.face, power, balance);
  return {
    ...pack,
    wiringExitMode: mode,
    serviceReservations: pack.serviceReservations.map((reservation) => {
      if (reservation.id === power.id) {
        return {
          ...reservation,
          enabled: combined.enabled,
          face: combined.face,
          offsetMm: offsets.power,
        };
      }
      if (reservation.id === balance.id) {
        return {
          ...reservation,
          enabled: combined.enabled,
          face: combined.face,
          offsetMm: offsets.balance,
        };
      }
      return reservation;
    }),
  };
}
