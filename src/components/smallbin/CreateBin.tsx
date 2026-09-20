import { useEffect, useRef, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import { ChevronDown, File as FileIcon, FileUp, X } from "lucide-react";
import { clientServices, defaultConfig, formatBytes } from "../../client/api";
import type { ClientServices, PublicConfig } from "../../client/api";
import { ShareResult } from "./ShareResult";
import { validateFiles } from "../../shared/crypto";

export function CreateBin({ services = clientServices, origin = window.location.origin }: { services?: ClientServices; origin?: string }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [config, setConfig] = useState<PublicConfig>(defaultConfig);
  const [configState, setConfigState] = useState<"loading" | "ready" | "error">("loading");
  const [configAttempt, setConfigAttempt] = useState(0);
  const [ttlSeconds, setTtlSeconds] = useState(defaultConfig.defaultTtlSeconds);
  const [phase, setPhase] = useState<"idle" | "encrypting" | "uploading">("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<{ link: string; expiresAt: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const activeOperation = useRef<AbortController | null>(null);
  const busy = phase !== "idle";
  const textBytes = new TextEncoder().encode(text).byteLength;
  const fileBytes = files.reduce((total, file) => total + file.size, 0);

  useEffect(() => {
    const controller = new AbortController();
    setConfigState("loading");
    services.config(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setConfig(value); setTtlSeconds(value.defaultTtlSeconds); setConfigState("ready");
    }).catch(() => { if (!controller.signal.aborted) setConfigState("error"); });
    return () => controller.abort();
  }, [services, configAttempt]);

  useEffect(() => () => { activeOperation.current?.abort(); }, []);

  function selectFiles(selected: FileList | File[]) {
    if (busy || !selected.length) return;
    setError(""); setNotice("");
    const candidate = [...files, ...Array.from(selected)];
    try {
      validateFiles(candidate);
      setFiles(candidate);
    } catch (error) {
      setError(error instanceof Error ? error.message : "These files could not be added.");
    }
  }

  function removeFile(index: number) {
    setFiles(current => current.filter((_, fileIndex) => fileIndex !== index));
    setError(""); setNotice("");
  }

  function drop(event: DragEvent) {
    event.preventDefault(); setDragging(false);
    if (event.dataTransfer.files.length) selectFiles(event.dataTransfer.files);
  }

  function cancel() {
    activeOperation.current?.abort();
    activeOperation.current = null;
    setPhase("idle"); setProgress(0); setNotice("Cancelled. Your draft is still here.");
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || configState !== "ready") return;
    setError(""); setNotice("");
    if (!text.length && !files.length) { setError("Add some text or a file to create a bin."); return; }
    if (textBytes > config.maxTextBytes) { setError(`Text can be up to ${formatBytes(config.maxTextBytes)} in UTF-8.`); return; }
    const controller = new AbortController();
    activeOperation.current = controller;
    setPhase("encrypting"); setProgress(0);
    try {
      const encrypted = await services.encrypt({ text, files });
      if (controller.signal.aborted) return;
      setPhase("uploading");
      const created = await services.upload(encrypted.payload, ttlSeconds, controller.signal, value => {
        if (!controller.signal.aborted) setProgress(value);
      });
      if (controller.signal.aborted) return;
      setResult({ link: `${origin}/b/${created.id}#${encrypted.key}`, expiresAt: created.expiresAt });
      setText(""); setFiles([]);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Something went wrong. Please try again.");
    } finally {
      if (activeOperation.current === controller) { activeOperation.current = null; setPhase("idle"); }
    }
  }

  if (result) return <section className="workspace-card" aria-label="Your shared bin"><div className="card-heading"><h1>Link created</h1></div><ShareResult {...result} onReset={() => { setResult(null); setError(""); setNotice(""); }} /></section>;

  return <section className="workspace-card" aria-label="Create a bin">
    <div className="card-heading"><h1>New bin</h1></div>
    <form onSubmit={create} className="create-form">
      <div className="label-row"><label className="field-label" htmlFor="bin-text">Your message<span className="optional">optional</span></label><span className={textBytes > config.maxTextBytes ? "counter over-limit" : "counter"} id="text-limit">{textBytes ? `${formatBytes(textBytes)} / ` : ""}{formatBytes(config.maxTextBytes)} max</span></div>
      <textarea id="bin-text" name="message" placeholder="Enter text…" value={text} onChange={event => { setText(event.target.value); setError(""); setNotice(""); }} disabled={busy} aria-describedby="text-limit" aria-invalid={textBytes > config.maxTextBytes} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
      <div className="attachment-heading"><label className="field-label" htmlFor="bin-file">Attachments<span className="optional">optional</span></label><span className="counter" id="files-limit">{files.length ? `${formatBytes(fileBytes)} / ` : ""}{formatBytes(config.maxFileBytes)} total</span></div>
      <input id="bin-file" className="sr-only" type="file" multiple tabIndex={-1} ref={fileInput} disabled={busy} aria-describedby="files-limit" onChange={event => { if (event.target.files?.length) selectFiles(event.target.files); event.target.value = ""; }} />
      <div className={`dropzone${dragging ? " dragging" : ""}`} onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
        {files.length > 0 && <ul className="attachment-list" aria-label="Selected files">{files.map((file, index) => <li className="attachment-row" key={`${index}-${file.name}`}><span className="file-icon"><FileIcon size={20} strokeWidth={1.5} /></span><div className="file-details"><span className="file-name" title={file.name}>{file.name}</span><span>{formatBytes(file.size)}</span></div><button className="icon-button" type="button" aria-label={`Remove ${file.name}, attachment ${index + 1}`} disabled={busy} onClick={() => removeFile(index)}><X size={16} /></button></li>)}</ul>}
        <button className="drop-button" type="button" disabled={busy} onClick={() => fileInput.current?.click()}><FileUp size={18} strokeWidth={1.5} /><span>{files.length ? "Drop more files here" : "Drop files here"} <span className="muted">or</span> <span className="underlined">browse</span></span></button>
      </div>
      <div className="form-controls"><div className="expiry-control"><label htmlFor="bin-expiry">Expires after</label><div className="select-wrap"><select id="bin-expiry" value={ttlSeconds} onChange={event => setTtlSeconds(Number(event.target.value))} disabled={busy}>{config.expiryOptions.map(option => <option key={option.seconds} value={option.seconds}>{option.label}</option>)}</select><ChevronDown size={14} /></div></div><button className="button button-primary create-button" type="submit" disabled={busy || configState !== "ready"}>{phase === "encrypting" ? "Encrypting…" : phase === "uploading" ? "Uploading…" : "Create private link"}{busy && <span className="spinner" />}</button></div>
      {configState === "error" && <div role="alert" className="form-alert">Couldn’t connect to Smallbin. <button type="button" className="inline-button" onClick={() => setConfigAttempt(value => value + 1)}>Retry connection</button></div>}
      {configState === "loading" && <p className="form-notice" role="status">Connecting to Smallbin…</p>}
      {busy && <div className="upload-status" role="status"><div><span>{phase === "encrypting" ? "Encrypting on your device…" : progress === 100 ? "Finishing your upload…" : `Uploading encrypted data · ${progress}%`}</span><button type="button" className="inline-button" onClick={cancel}>Cancel</button></div><progress aria-label={phase === "encrypting" ? "Encrypting" : "Upload progress"} {...(phase === "uploading" ? { value: progress } : {})} max={100} /></div>}
      {error && <p className="form-alert" role="alert">{error}</p>}
      {notice && <p className="form-notice" role="status">{notice}</p>}
    </form>
    <p className="card-footnote">Content is encrypted in your browser. Links expire automatically.</p>
  </section>;
}
