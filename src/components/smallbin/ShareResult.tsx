import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy, Download, Plus, ScanLine } from "lucide-react";
import { downloadBlob } from "../../client/api";
import { createQrMatrix, createQrPng } from "../../client/qr";

export function QrCode({ value }: { value: string }) {
  const matrix = useMemo(() => createQrMatrix(value), [value]);
  const path: string[] = [];
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (matrix.get(y, x)) path.push(`M${x + 4},${y + 4}h1v1h-1z`);
    }
  }
  return <svg className="qr-code" viewBox={`0 0 ${matrix.size + 8} ${matrix.size + 8}`} role="img" aria-label="QR code containing the complete private share link" shapeRendering="crispEdges">
    <rect width="100%" height="100%" fill="white" />
    <path d={path.join("")} fill="black" />
  </svg>;
}

export function QrDownloadButton({ value }: { value: string }) {
  const [state, setState] = useState<"idle" | "preparing" | "error">("idle");
  const operation = useRef<AbortController | null>(null);
  const release = useRef<(() => void) | null>(null);
  useEffect(() => () => { operation.current?.abort(); release.current?.(); }, []);
  async function download() {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setState("preparing");
    try {
      const image = await createQrPng(value);
      if (controller.signal.aborted) return;
      release.current?.();
      release.current = downloadBlob(image, "smallbin-qr.png");
      setState("idle");
    } catch {
      if (!controller.signal.aborted) setState("error");
    } finally { operation.current = null; }
  }
  return <>
    <button className="text-button" type="button" title="Download as PNG" onClick={download} disabled={state === "preparing"}>
      <Download size={16} />{state === "preparing" ? "Preparing…" : "Download QR code"}
    </button>
    {state === "error" && <p className="copy-error" role="alert">Couldn’t download the QR code. Try again.</p>}
  </>;
}

export function CopyButton({ value, label = "Copy link" }: { value: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  async function copy() {
    try { await navigator.clipboard.writeText(value); setState("copied"); }
    catch { setState("error"); }
  }
  return <>
    <button className="button button-primary" type="button" onClick={copy}>
      {state === "copied" ? <Check size={16} /> : <Copy size={16} />}{state === "copied" ? "Copied" : label}
    </button>
    <span className={state === "error" ? "copy-error" : "sr-only"} role="status">
      {state === "error" ? "Clipboard unavailable. Select and copy the text manually." : state === "copied" ? "Copied to clipboard." : ""}
    </span>
  </>;
}

export function Expiry({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  })}</time>;
}

export function ShareResult({ link, expiresAt, onReset }: { link: string; expiresAt: string; onReset: () => void }) {
  const [qrVisible, setQrVisible] = useState(false);
  return <div className="result-content">
    <p className="muted">Anyone with this link can open the bin.</p>
    <label className="field-label" htmlFor="share-link">Private share link</label>
    <div className="share-link-row">
      <input id="share-link" readOnly value={link} onFocus={event => event.currentTarget.select()} autoComplete="off" spellCheck={false} />
      <CopyButton value={link} />
    </div>
    <div className="share-actions">
      <button className="text-button" type="button" aria-expanded={qrVisible} onClick={() => setQrVisible(!qrVisible)}><ScanLine size={16} />{qrVisible ? "Hide QR code" : "Show QR code"}</button>
      <a className="text-button" href={link} target="_blank" rel="noreferrer">Open bin<ArrowUpRight size={16} /></a>
    </div>
    {qrVisible && <div className="qr-panel"><QrCode value={link} /><div><p>Scan to open the full private link.<br />Generated on your device.</p><QrDownloadButton key={link} value={link} /></div></div>}
    <div className="expiry-line"><span>Available until <Expiry value={expiresAt} /></span></div>
    <div className="result-footer"><button className="text-button" type="button" onClick={onReset}><Plus size={16} />Create another bin</button><span>Save your link before leaving.</span></div>
  </div>;
}
