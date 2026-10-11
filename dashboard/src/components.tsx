import { useState } from "react";
import { copyToClipboard } from "./lib/api";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn btnSecondary btnSmall"
      onClick={async () => {
        if (!(await copyToClipboard(value))) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <div className="codeBlock">
      <pre>{code}</pre>
      <CopyButton value={code} />
    </div>
  );
}

// Gateway server status (Connected / Unreachable / Disabled / Unknown) and audit outcomes share one pill.
const TONE: Record<string, string> = {
  Connected: "good",
  ok: "good",
  active: "good",
  Unreachable: "bad",
  timeout: "bad",
  unreachable: "bad",
  tool_error: "warn",
  bad_request: "warn",
  denied: "bad",
  not_found: "warn",
  revoked: "muted",
  disabled: "muted",
  Disabled: "muted",
};

export function StatusPill({ value }: { value: string }) {
  return <span className={`statusPill tone-${TONE[value] ?? "neutral"}`}>{value}</span>;
}

export function Banner({ error, notice, onClose }: { error?: string | null; notice?: string | null; onClose?: () => void }) {
  if (!error && !notice) return null;
  return (
    <div className={`pageBanner ${error ? "pageBannerError" : "pageBannerInfo"}`} role={error ? "alert" : "status"}>
      <span>{error ?? notice}</span>
      {onClose && (
        <button className="inlineLink" onClick={onClose}>
          Dismiss
        </button>
      )}
    </div>
  );
}
