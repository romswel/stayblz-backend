import type { Request } from "express";
import { isUuid, type StableRequest } from "../middleware/stable";
export const scope = (req: Request) => req as StableRequest;
// Preserve PostgreSQL's microseconds; converting through Date would truncate
// the cursor and skip messages sharing the same millisecond.
export function messageCursor(value: unknown) {
  if (typeof value !== "string") return null;
  const parts = value.split("|");
  if (parts.length !== 2) return null;
  const [time, id] = parts;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(time) ||
    !Number.isFinite(Date.parse(time)) ||
    !isUuid(id)
  ) return null;
  return { time, id };
}
export function text(value: unknown, max: number, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new Error("invalid_input");
  return value.trim();
}
function number(value: unknown, min: number, max: number, fallback: number) {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error("invalid_input");
  return value;
}
export function horseInput(value: Record<string, unknown>) {
  const date = text(
    value.acquiredAt,
    10,
    new Date().toISOString().slice(0, 10),
  );
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new Error("invalid_input");
  return {
    horseName: text(value.horseName, 120),
    breed: text(value.breed, 80, "Thoroughbred"),
    age: number(value.age, 0, 50, 0),
    sex: text(value.sex, 30, "Not recorded"),
    status: text(value.status, 40, "Active"),
    stable: text(value.stable, 100, "Stable"),
    valueUsd: number(value.valueUsd, 0, 1e12, 0),
    acquiredAt: date,
    saddlecloth: number(value.saddlecloth, 0, 99, 0),
    silksColor: "#365b43",
    coatColor: "#704a32",
    maneColor: "#2f261e",
    blaze: false,
  };
}
export function trackingInput(value: Record<string, unknown>) {
  const allowed = [
    "Race ready",
    "In training",
    "Recovering",
    "Entered",
    "Resting",
  ];
  const status = text(value.status, 40, "Resting");
  if (!allowed.includes(status)) throw new Error("invalid_input");
  const field = (v: unknown, max: number) => (v === "" ? "" : text(v, max, ""));
  return {
    status,
    condition: number(value.condition, 0, 100, 0),
    trainer: field(value.trainer, 120),
    jockey: field(value.jockey, 120),
    form: field(value.form, 80),
    lastWorkout: field(value.lastWorkout, 200),
    nextRace:
      value.nextRace === null ||
      value.nextRace === "" ||
      value.nextRace === undefined
        ? null
        : text(value.nextRace, 200),
    location: field(value.location, 120),
  };
}
export const inventoryRecord = (row: any) => ({ id: row.id, ...row.inventory });
export const trackerRecord = (row: any) => ({
  id: row.id,
  ...row.inventory,
  ...row.tracking,
  name: row.inventory.horseName,
});
export const postRecord = (row: any) => ({
  id: row.id,
  author: row.author,
  role: row.role,
  body: row.body,
  createdAt: row.created_at,
});
export const messageRecord = (row: any, userId: string) => ({
  id: row.id,
  from: row.sender,
  body: row.body,
  sentAt: row.sent_at,
  mine: row.sender_id === userId,
});
export function participantIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 29 || !value.every(isUuid))
    throw new Error("invalid_input");
  return [...new Set(value)];
}
