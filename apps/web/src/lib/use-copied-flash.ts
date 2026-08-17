import { useEffect, useState } from "react";

/**
 * The "Copied" flash behind a copy-to-clipboard button: `copied` is true for
 * 2 s after `flash()`. The timer is owned by an effect so unmount CANCELS it -
 * a bare `setTimeout` in the click handler outlived the component and set
 * state into a torn-down environment, the latent bug both copy buttons
 * (channels export URL, the public link) shipped with. One hook, so the fix
 * cannot be applied to one button and forgotten on the next.
 */
export function useCopiedFlash(): { copied: boolean; flash: () => void } {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return { copied, flash: () => setCopied(true) };
}
