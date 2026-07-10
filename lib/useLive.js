"use client";
// Avertyn — realtime helper. Subscribe to postgres changes on a set of tables and
// call `onChange` (debounced) whenever any of them move, so a screen stays live
// instead of showing a load-time snapshot. Org scoping is enforced by RLS on the
// realtime stream, so we don't filter here.
import { useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

export function useLive(name, tables, onChange, active = true) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!active || !tables || tables.length === 0) return;
    let timer = null;
    const fire = () => { clearTimeout(timer); timer = setTimeout(() => cb.current && cb.current(), 250); };
    let ch = supabase.channel("live-" + name + "-" + Math.random().toString(36).slice(2, 8));
    tables.forEach((tbl) => { ch = ch.on("postgres_changes", { event: "*", schema: "public", table: tbl }, fire); });
    ch.subscribe();
    return () => { clearTimeout(timer); supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, active, (tables || []).join(",")]);
}
