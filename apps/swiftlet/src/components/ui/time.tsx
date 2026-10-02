import type { ComponentPropsWithRef } from "react";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (value: number) => String(value).padStart(2, "0");

export function shortDate(iso: string): string {
  const date = new Date(iso);
  return `${two(date.getDate())} ${months[date.getMonth()]}`;
}

function utcOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  return `UTC${sign}${two(Math.floor(Math.abs(minutes) / 60))}:${two(Math.abs(minutes) % 60)}`;
}

export function localTimestamp(iso: string): string {
  const date = new Date(iso);
  return `${shortDate(iso)} ${date.getFullYear()} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())} ${utcOffset(date)}`;
}

export function LocalTime({ iso, ...rest }: Omit<ComponentPropsWithRef<"time">, "dateTime" | "children"> & { iso: string }) {
  return <time dateTime={iso} {...rest}>{localTimestamp(iso)}</time>;
}
