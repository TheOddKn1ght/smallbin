import { useEffect, useRef, useState } from "react";
import { Download, File as FileIcon } from "lucide-react";
import { clientServices, ClientError, downloadFile, formatBytes } from "../../client/api";
import type { ClientServices } from "../../client/api";
import { CopyButton, Expiry } from "./ShareResult";

interface OpenBin {
  text: string;
  files: { name: string; type: string; bytes: Uint8Array }[];
  expiresAt: string;
}

export function ReceiveBin({ id, secret, services = clientServices }: { id: string; secret: string; services?: ClientServices }) {
  const [bin, setBin] = useState<OpenBin | null>(null);
  const [phase, setPhase] = useState("Retrieving encrypted data…");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const releases = useRef<(() => void)[]>([]);
  useEffect(() => () => { for (const release of releases.current) release(); }, []);
  useEffect(() => {
    setBin(null); setError("");
    if (!secret) { setError("The decryption key is missing. Ask the sender for the complete link, including everything after #."); return; }
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) { setError("This link has an invalid decryption key. Ask the sender for the complete link."); return; }
    const controller = new AbortController();
    setPhase("Retrieving encrypted data…");
    (async () => {
      try {
        const loaded = await services.retrieve(id, controller.signal);
        if (controller.signal.aborted) return;
        setPhase("Decrypting on your device…");
        let content;
        try { content = await services.decrypt(loaded.payload, secret); }
        catch { throw new ClientError("This bin couldn’t be decrypted. The key may be incorrect, or the data may have been changed."); }
        if (!controller.signal.aborted) setBin({ ...content, expiresAt: loaded.expiresAt });
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof ClientError ? error.message : "The connection was interrupted. Please try again.");
      }
    })();
    return () => controller.abort();
  }, [id, secret, services, attempt]);

  return <section className="workspace-card recipient-card" aria-label="Shared bin">
    <div className="card-heading"><h1>Shared bin</h1></div>
    {error ? <div className="recipient-state"><h2>Unable to open this bin.</h2><p role="alert">{error}</p>{secret && <button type="button" className="button button-primary" onClick={() => setAttempt(value => value + 1)}>Try again</button>}<a className="text-button" href="/">Create a new bin</a></div>
      : !bin ? <div className="recipient-state" role="status"><span className="spinner" /><h2>{phase}</h2><p>Your decryption key stays in this browser.</p></div>
      : <div className="received-content">
        {bin.text && <section className="message-section"><div className="label-row"><h2 className="field-label">Message</h2><CopyButton value={bin.text} label="Copy text" /></div><pre className="received-text" tabIndex={0}>{bin.text}</pre></section>}
        {bin.files.map((file, index) => <section className="received-attachment" key={`${index}-${file.name}`} aria-label={`Attachment ${index + 1}: ${file.name}`}><span className="file-icon"><FileIcon size={22} strokeWidth={1.5} /></span><div className="file-details"><span className="file-name" title={file.name}>{file.name}</span><span>{formatBytes(file.bytes.byteLength)}</span></div><button type="button" className="button button-outline" aria-label={`Download ${file.name}, attachment ${index + 1}`} onClick={() => releases.current.push(downloadFile(file))}><Download size={16} />Download file</button></section>)}
        <div className="expiry-line"><span>Available until <Expiry value={bin.expiresAt} /></span></div>
        <p className="recipient-note">Expiry removes access on the server. Copies already opened or downloaded stay with their recipients.</p>
      </div>}
  </section>;
}
