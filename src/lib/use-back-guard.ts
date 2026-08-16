"use client";

import { useEffect, useRef } from "react";

/**
 * Makes Android's back button behave like an app's, not a browser's.
 *
 * Without this, back leaves the site entirely — mid-batch, straight to whatever
 * page was open before. The fix is to keep one sentinel entry on the history
 * stack: back pops it, we handle the gesture ourselves, then push it again so
 * the next press is ours too.
 *
 * `onBack` returns true if it consumed the press (e.g. it closed a sheet).
 * When it returns false there is nothing left to close, so `onExit` decides
 * whether to actually leave.
 */
export function useBackGuard(
  onBack: () => boolean,
  onExit: () => boolean,
): void {
  const backRef = useRef(onBack);
  const exitRef = useRef(onExit);
  backRef.current = onBack;
  exitRef.current = onExit;

  useEffect(() => {
    if (typeof window === "undefined") return;

    const arm = () => window.history.pushState({ lamlem: true }, "");
    arm();

    let leaving = false;

    const onPop = () => {
      // Set when the user confirmed an exit: let this pop through untouched.
      if (leaving) return;

      if (backRef.current()) {
        arm();
        return;
      }
      if (exitRef.current()) {
        leaving = true;
        // The sentinel is already gone, so one more step leaves the app.
        window.history.back();
        return;
      }
      arm();
    };

    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
}
