export const VEHICLES = [
  { id: "ALSVIN", name: "ALSVIN" },
  { id: "CS-35-PLUS", name: "CS 35 Plus" },
  { id: "CS-75-PLUS", name: "CS 75 Plus" },
  { id: "CS-95", name: "CS 95" },
  { id: "EADO-PLUS", name: "EADO Plus" },
  { id: "HUNTER-PLUS", name: "Hunter" },
  { id: "UNI-K", name: "UNI-K" },
  { id: "UNI-S", name: "UNI S" },
  { id: "UNI-T", name: "UNI-T" },
  { id: "UNI-V", name: "UNI V" },
] as const;

export type VehicleId = (typeof VEHICLES)[number]["id"];

export function isVehicleId(value: string): value is VehicleId {
  return VEHICLES.some((vehicle) => vehicle.id === value);
}
