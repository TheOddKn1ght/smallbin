import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { ClientServices } from "../../src/client/api";
import { ClientError, clientServices, defaultConfig } from "../../src/client/api";

const dom = new Window({ url: "https://smallbin.test/" });
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "MutationObserver", "getComputedStyle"]) {
  originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value: (dom as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
}
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { render, fireEvent, waitFor, cleanup, act } = await import("@testing-library/react");
const { CreateBin } = await import("../../src/components/smallbin/CreateBin");
const { ReceiveBin } = await import("../../src/components/smallbin/ReceiveBin");
const { CopyButton, QrCode, ShareResult } = await import("../../src/components/smallbin/ShareResult");
const { Privacy } = await import("../../src/components/smallbin/Privacy");

const key = "a".repeat(43);
const id = "abcdefghijklmnopqrstuv";
const expiresAt = "2030-01-01T01:00:00.000Z";
function services(overrides: Partial<ClientServices> = {}): ClientServices {
  return {
    config: mock(async () => defaultConfig),
    encrypt: mock(async () => ({ payload: new Uint8Array([10, 20, 30]), key })),
    decrypt: mock(async () => ({ text: "Hello, privately.", files: [] })),
    upload: mock(async () => ({ id, expiresAt })),
    retrieve: mock(async () => ({ payload: new Uint8Array([10, 20, 30]).buffer, expiresAt })),
    ...overrides,
  };
}
async function ready(view: ReturnType<typeof render>) {
  await waitFor(() => expect((view.getByRole("button", { name: "Create private link" }) as HTMLButtonElement).disabled).toBe(false));
}
const clipboard = mock(async (_value: string) => {});
Object.defineProperty(dom.navigator, "clipboard", { value: { writeText: clipboard }, configurable: true });
afterEach(() => { cleanup(); clipboard.mockClear(); });
afterAll(() => {
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  dom.happyDOM.abort();
});

describe("creation form", () => {
  test("starts with empty text, a 5-minute expiry, and all six expiry choices", async () => {
    const view = render(<CreateBin services={services()} origin="https://smallbin.test" />);
    await ready(view);
    expect((view.getByLabelText(/Your message/) as HTMLTextAreaElement).value).toBe("");
    expect((view.getByLabelText("Expires after") as HTMLSelectElement).value).toBe("300");
    expect(view.getAllByRole("option")).toHaveLength(6);
    fireEvent.click(view.getByRole("button", { name: "Create private link" }));
    expect(view.getByRole("alert").textContent).toContain("Add some text or a file");
  });
  test("blocks creation on configuration failure and supports retry", async () => {
    let attempts = 0;
    const service = services({ config: mock(async () => { if (!attempts++) throw new Error(); return defaultConfig; }) });
    const view = render(<CreateBin services={service} />);
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Couldn’t connect"));
    expect((view.getByRole("button", { name: "Create private link" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Retry connection" }));
    await ready(view);
  });
  test("creates combined text and file, offers local QR, copies full link, and clears draft", async () => {
    const service = services();
    const view = render(<CreateBin services={service} origin="https://smallbin.test" />);
    await ready(view);
    fireEvent.change(view.getByLabelText(/Your message/), { target: { value: "a private note" } });
    const file = new File(["secret attachment"], "notes.txt", { type: "text/plain" });
    fireEvent.change(view.getByLabelText(/Attachment/), { target: { files: [file] } });
    fireEvent.change(view.getByLabelText("Expires after"), { target: { value: "3600" } });
    fireEvent.click(view.getByRole("button", { name: "Create private link" }));
    await waitFor(() => expect(view.getByLabelText("Private share link")).toBeTruthy());
    const link = `https://smallbin.test/b/${id}#${key}`;
    expect((view.getByLabelText("Private share link") as HTMLInputElement).value).toBe(link);
    expect(service.encrypt).toHaveBeenCalledWith({ text: "a private note", files: [file] });
    expect(service.upload).toHaveBeenCalledWith(new Uint8Array([10, 20, 30]), 3600, expect.any(AbortSignal), expect.any(Function));
    fireEvent.click(view.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(link));
    fireEvent.click(view.getByRole("button", { name: "Show QR code" }));
    expect(view.getByRole("img", { name: /QR code/ })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Hide QR code" }));
    expect(view.queryByRole("img", { name: /QR code/ })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Create another bin" }));
    expect((view.getByLabelText(/Your message/) as HTMLTextAreaElement).value).toBe("");
    expect(view.queryByText("notes.txt")).toBeNull();
  });
  test("validates UTF-8 bytes and oversized files while accepting multiple file selection", async () => {
    const service = services(); const view = render(<CreateBin services={service} />); await ready(view);
    const text = "😺".repeat(250_001);
    fireEvent.change(view.getByLabelText(/Your message/), { target: { value: text } });
    fireEvent.click(view.getByRole("button", { name: "Create private link" }));
    expect(view.getByRole("alert").textContent).toContain("UTF-8");
    expect(service.encrypt).not.toHaveBeenCalled();
    const oversized = new File(["x"], "large.bin"); Object.defineProperty(oversized, "size", { value: 100_000_001 });
    fireEvent.change(view.getByLabelText(/Attachment/), { target: { files: [oversized] } });
    expect(view.getByRole("alert").textContent).toContain("100 MB");
    fireEvent.change(view.getByLabelText(/Attachment/), { target: { files: [new File([], "a"), new File([], "b")] } });
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getAllByRole("listitem")).toHaveLength(2);
  });
  test("accepts zero-byte files alone and supports removal and drop", async () => {
    const service = services(); const view = render(<CreateBin services={service} />); await ready(view);
    const file = new File([], "empty.txt");
    fireEvent.drop(view.getByRole("button", { name: /Drop files/ }).parentElement!, { dataTransfer: { files: [file] } });
    expect(view.getByText("empty.txt")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Remove empty.txt, attachment 1" }));
    expect(view.queryByText("empty.txt")).toBeNull();
    fireEvent.change(view.getByLabelText(/Attachment/), { target: { files: [file] } });
    fireEvent.click(view.getByRole("button", { name: "Create private link" }));
    await waitFor(() => expect(service.encrypt).toHaveBeenCalledWith({ text: "", files: [file] }));
  });
  test("cancellation during encryption prevents a late upload and keeps the draft", async () => {
    let resolveEncryption!: (value: Awaited<ReturnType<ClientServices["encrypt"]>>) => void;
    const service = services({ encrypt: mock(() => new Promise<Awaited<ReturnType<ClientServices["encrypt"]>>>(resolve => { resolveEncryption = resolve; })) });
    const view = render(<CreateBin services={service} />); await ready(view);
    fireEvent.change(view.getByLabelText(/Your message/), { target: { value: "keep this draft" } });
    const draftFiles = [new File(["a"], "first.txt"), new File(["b"], "second.txt")];
    fireEvent.change(view.getByLabelText(/Attachment/), { target: { files: draftFiles } });
    fireEvent.click(view.getByRole("button", { name: "Create private link" }));
    expect(view.getByRole("button", { name: "Encrypting…" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    await act(async () => resolveEncryption({ payload: new Uint8Array([1]), key }));
    expect(service.upload).not.toHaveBeenCalled();
    expect((view.getByLabelText(/Your message/) as HTMLTextAreaElement).value).toBe("keep this draft");
    expect(view.getByRole("status").textContent).toContain("Cancelled");
    expect(view.getAllByRole("listitem")).toHaveLength(2);
    expect(service.encrypt).toHaveBeenCalledWith({ text: "keep this draft", files: draftFiles });
  });
  test("shows upload progress and aborts an active upload", async () => {
    let signal: AbortSignal | undefined;
    const service = services({ upload: mock((_payload, _ttl, uploadSignal, progress) => {
      signal = uploadSignal; progress(42);
      return new Promise<Awaited<ReturnType<ClientServices["upload"]>>>((_resolve, reject) => uploadSignal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError"))));
    }) });
    const view = render(<CreateBin services={service} />); await ready(view);
    fireEvent.change(view.getByLabelText(/Your message/), { target: { value: "upload this" } });
    fireEvent.click(view.getByRole("button", { name: "Create private link" }));
    await waitFor(() => expect(view.getByRole("progressbar").getAttribute("value")).toBe("42"));
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(signal?.aborted).toBe(true);
    await ready(view);
  });
  test("preserves draft on upload failure and retries successfully", async () => {
    let tries = 0; const service = services({ upload: mock(async () => { if (!tries++) throw new ClientError("The upload timed out. Please try again."); return { id, expiresAt }; }) });
    const view = render(<CreateBin services={service} />); await ready(view);
    fireEvent.change(view.getByLabelText(/Your message/), { target: { value: "retry me" } });
    const draftFiles = [new File(["a"], "first.txt"), new File(["b"], "second.txt")];
    fireEvent.change(view.getByLabelText(/Attachment/), { target: { files: draftFiles } });
    fireEvent.click(view.getByRole("button", { name: "Create private link" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("timed out"));
    expect((view.getByLabelText(/Your message/) as HTMLTextAreaElement).value).toBe("retry me");
    expect(view.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(view.getByRole("button", { name: "Create private link" }));
    await waitFor(() => expect(view.getByLabelText("Private share link")).toBeTruthy());
  });
});

describe("recipient", () => {
  test.each(["", "invalid"])("does not fetch with missing or malformed key %s", secret => {
    const service = services(); const view = render(<ReceiveBin id={id} secret={secret} services={service} />);
    expect(view.getByRole("alert").textContent).toContain(secret ? "invalid decryption key" : "decryption key is missing");
    expect(service.retrieve).not.toHaveBeenCalled();
  });
  test("renders hostile text literally, copies text, and exposes attachment only as download", async () => {
    const malicious = '<img src="https://evil.test/pixel" onerror="alert(1)">';
    const service = services({ decrypt: mock(async () => ({ text: malicious, files: [{ name: "../../evil.html", type: "text/html", bytes: new Uint8Array([1, 2]) }] })) });
    const view = render(<ReceiveBin id={id} secret={key} services={service} />);
    await waitFor(() => expect(view.getByText(malicious)).toBeTruthy());
    expect(view.container.querySelector("img, iframe, object, embed")).toBeNull();
    expect(view.getByRole("button", { name: /^Download/ })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Copy text" }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(malicious));
    expect(service.retrieve).toHaveBeenCalledWith(id, expect.any(AbortSignal));
    expect(service.decrypt).toHaveBeenCalledWith(expect.any(ArrayBuffer), key);
  });
  test("explains unavailable bins and supports retry", async () => {
    let attempts = 0; const service = services({ retrieve: mock(async () => { if (!attempts++) throw new ClientError("This bin is unavailable."); return { payload: new ArrayBuffer(0), expiresAt }; }) });
    const view = render(<ReceiveBin id={id} secret={key} services={service} />);
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("unavailable"));
    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(view.getByText("Hello, privately.")).toBeTruthy());
  });
  test("wrong keys and altered ciphertext have an actionable decryption error", async () => {
    const service = services({ decrypt: mock(async () => { throw new Error("authentication failed"); }) });
    const view = render(<ReceiveBin id={id} secret={key} services={service} />);
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("couldn’t be decrypted"));
    expect(view.queryByRole("button", { name: /^Download/ })).toBeNull();
  });
});

test("clipboard failure leaves a manual-copy instruction", async () => {
  clipboard.mockImplementationOnce(async () => { throw new Error("denied"); });
  const view = render(<CopyButton value="private" />);
  fireEvent.click(view.getByRole("button", { name: "Copy link" }));
  await waitFor(() => expect(view.getByRole("status").textContent).toContain("Select and copy"));
});

test("QR is a local vector with no external resource or raw HTML injection", () => {
  const view = render(<QrCode value={`https://smallbin.test/b/${id}#${key}`} />);
  const svg = view.getByRole("img");
  expect(svg.tagName).toBe("svg");
  expect(svg.querySelector("path")?.getAttribute("d")?.length).toBeGreaterThan(100);
  expect(svg.querySelector("image, script, foreignObject")).toBeNull();
});

function qrDownloadFixture() {
  const png = new Blob(["synthetic PNG"], { type: "image/png" });
  const canvasPrototype = dom.HTMLCanvasElement.prototype as unknown as HTMLCanvasElement;
  const drawing = { fillStyle: "", fillRect: mock(() => {}) } as unknown as CanvasRenderingContext2D;
  const getContext = spyOn(canvasPrototype, "getContext").mockReturnValue(drawing);
  const encode = spyOn(canvasPrototype, "toBlob").mockImplementation(callback => callback(png));
  const blobs: Blob[] = [];
  const create = spyOn(URL, "createObjectURL").mockImplementation(blob => {
    blobs.push(blob as Blob); return `blob:qr-${blobs.length}`;
  });
  const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const filenames: string[] = [];
  const click = spyOn(dom.HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { filenames.push(this.download); });
  const view = render(<ShareResult link={`https://smallbin.test/b/${id}#${key}`} expiresAt={expiresAt} onReset={() => {}} />);
  return { view, png, getContext, encode, create, revoke, filenames, blobs, click, restore() {
    view.unmount(); getContext.mockRestore(); encode.mockRestore(); create.mockRestore(); revoke.mockRestore(); click.mockRestore();
  } };
}

test("QR downloads are explicit PNGs; repeated downloads and hiding the panel release temporary URLs", async () => {
  const fixture = qrDownloadFixture();
  try {
    const { view, png, encode, filenames, blobs, revoke } = fixture;
    expect(view.queryByRole("button", { name: "Download QR code" })).toBeNull();
    expect(encode).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Show QR code" }));
    expect(encode).not.toHaveBeenCalled();
    for (let index = 1; index <= 2; index++) {
      fireEvent.click(view.getByRole("button", { name: "Download QR code" }));
      await waitFor(() => expect(filenames).toHaveLength(index));
      expect(filenames[index - 1]).toBe("smallbin-qr.png");
      expect(blobs[index - 1]).toBe(png);
    }
    expect(encode).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(revoke).toHaveBeenCalledWith("blob:qr-1");
    expect(view.getByRole("img", { name: /QR code/ })).toBeTruthy();
    expect(dom.document.querySelector("a[download]")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Hide QR code" }));
    expect(revoke).toHaveBeenCalledWith("blob:qr-2");
  } finally { fixture.restore(); }
});

test.each(["canvas unavailable", "encoding failed", "download blocked"])("QR download recovers from %s", async failure => {
  const fixture = qrDownloadFixture();
  try {
    if (failure === "canvas unavailable") fixture.getContext.mockReturnValueOnce(null);
    if (failure === "encoding failed") fixture.encode.mockImplementationOnce(callback => callback(null));
    if (failure === "download blocked") fixture.click.mockImplementationOnce(() => { throw new Error("denied"); });
    const { view } = fixture;
    fireEvent.click(view.getByRole("button", { name: "Show QR code" }));
    fireEvent.click(view.getByRole("button", { name: "Download QR code" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Try again"));
    if (failure === "download blocked") expect(fixture.revoke).toHaveBeenCalledWith("blob:qr-1");
    expect(dom.document.querySelector("a[download]")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Download QR code" }));
    await waitFor(() => expect(fixture.filenames).toEqual(["smallbin-qr.png"]));
    expect(view.queryByRole("alert")).toBeNull();
  } finally { fixture.restore(); }
});

test("hiding the QR panel during encoding prevents a late download", async () => {
  const fixture = qrDownloadFixture();
  try {
    let finish!: BlobCallback;
    fixture.encode.mockImplementation(callback => { finish = callback; });
    const { view } = fixture;
    fireEvent.click(view.getByRole("button", { name: "Show QR code" }));
    fireEvent.click(view.getByRole("button", { name: "Download QR code" }));
    expect((view.getByRole("button", { name: "Preparing…" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Hide QR code" }));
    await act(async () => { finish(fixture.png); });
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.click).not.toHaveBeenCalled();
  } finally { fixture.restore(); }
});

test("privacy page describes metadata, copies, infrastructure, and trust limits", () => {
  const view = render(<Privacy />);
  for (const text of ["AES-256-GCM", "complete anonymity", "random process secret", "physical erasure", "compromised server"]) {
    expect(view.container.textContent).toContain(text);
  }
  expect(view.container.querySelectorAll("a[href^='http']")).toHaveLength(0);
});

test("downloads attachments only on request as octet-stream with a sanitized filename", async () => {
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;
  const click = dom.HTMLAnchorElement.prototype.click;
  let downloadedBlob: Blob | undefined;
  let clickedDownload: string | undefined;
  const revoke = mock((_url: string) => {});
  URL.createObjectURL = (blob: Blob) => { downloadedBlob = blob; return "blob:smallbin-download"; };
  URL.revokeObjectURL = revoke;
  dom.HTMLAnchorElement.prototype.click = function () { clickedDownload = this.download; };
  try {
    const service = services({ decrypt: mock(async () => ({ text: "", files: [{ name: "../../evil.html", type: "text/html", bytes: new Uint8Array([1, 2, 3]) }] })) });
    const view = render(<ReceiveBin id={id} secret={key} services={service} />);
    await waitFor(() => expect(view.getByRole("button", { name: /^Download/ })).toBeTruthy());
    expect(downloadedBlob).toBeUndefined();
    fireEvent.click(view.getByRole("button", { name: /^Download/ }));
    expect(downloadedBlob?.type).toBe("application/octet-stream");
    expect(clickedDownload).toBe("_.._evil.html");
    expect([...new Uint8Array(await downloadedBlob!.arrayBuffer())]).toEqual([1, 2, 3]);
    view.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:smallbin-download");
  } finally {
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    dom.HTMLAnchorElement.prototype.click = click;
  }
});

test("editing a draft clears the stale empty-input validation error", async () => {
  const view = render(<CreateBin services={services()} />); await ready(view);
  fireEvent.click(view.getByRole("button", { name: "Create private link" }));
  expect(view.getByRole("alert").textContent).toContain("Add some text");
  fireEvent.change(view.getByLabelText(/Your message/), { target: { value: "now this has text" } });
  expect(view.queryByRole("alert")).toBeNull();
});

test("fragment changes update the recipient and skip navigation preserves the secret", async () => {
  const { App } = await import("../../src/App");
  dom.history.replaceState(null, "", `/b/${id}#invalid`);
  const view = render(<App />);
  expect(view.getByRole("alert").textContent).toContain("invalid decryption key");
  fireEvent.click(view.getByRole("link", { name: "Skip to content" }));
  expect(dom.location.hash).toBe("#invalid");
  expect(dom.document.activeElement?.id).toBe("main");
  act(() => {
    dom.history.replaceState(null, "", `/b/${id}`);
    dom.dispatchEvent(new dom.HashChangeEvent("hashchange"));
  });
  expect(view.getByRole("alert").textContent).toContain("decryption key is missing");
  view.unmount();
  dom.history.replaceState(null, "", "/");
});

describe("header navigation", () => {
  test("opens privacy without a document load, focuses content, and returns to an empty creation form", async () => {
    const { App } = await import("../../src/App");
    dom.history.replaceState(null, "", "/");
    const config = spyOn(clientServices, "config").mockResolvedValue(defaultConfig);
    const open = spyOn(dom, "open").mockReturnValue(null);
    const scroll = spyOn(dom, "scrollTo").mockImplementation(() => {});
    const push = spyOn(dom.history, "pushState");
    try {
      const view = render(<App />); await ready(view);
      fireEvent.change(view.getByLabelText(/Your message/), { target: { value: "private draft" } });
      const shell = view.container.firstChild;
      fireEvent.click(view.getByRole("link", { name: "Privacy" }));
      expect(view.getByRole("heading", { name: "Privacy", level: 1 })).toBeTruthy();
      expect(view.container.firstChild).toBe(shell);
      expect(dom.location.pathname).toBe("/privacy");
      expect(dom.document.title).toBe("Privacy | Smallbin");
      expect(push).toHaveBeenCalledWith(null, "", "/privacy");
      expect(dom.history.state).toBeNull();
      expect(dom.document.activeElement?.id).toBe("main");
      expect(scroll).toHaveBeenCalledWith(0, 0);
      expect(open).not.toHaveBeenCalled();
      expect(view.getByRole("link", { name: "Privacy" }).getAttribute("aria-current")).toBe("page");
      fireEvent.click(view.getByRole("link", { name: "Smallbin home" }));
      await ready(view);
      expect(dom.location.pathname).toBe("/");
      expect(dom.document.title).toBe("Smallbin");
      expect((view.getByLabelText(/Your message/) as HTMLTextAreaElement).value).toBe("");
      expect(view.getByRole("link", { name: "New bin" }).getAttribute("aria-current")).toBe("page");
      expect(open).not.toHaveBeenCalled();
    } finally {
      cleanup(); config.mockRestore(); open.mockRestore(); scroll.mockRestore(); push.mockRestore();
      dom.history.replaceState(null, "", "/");
    }
  });

  test.each([
    { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 },
  ])("leaves modified clicks to the browser: %j", async options => {
    const { App } = await import("../../src/App");
    dom.history.replaceState(null, "", `/b/${id}#invalid`);
    const open = spyOn(dom, "open").mockReturnValue(null);
    const push = spyOn(dom.history, "pushState");
    try {
      const view = render(<App />);
      const event = new dom.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...options });
      fireEvent(view.getByRole("link", { name: "Privacy" }), event as unknown as Event);
      expect(event.defaultPrevented).toBe(false);
      expect(push).not.toHaveBeenCalled();
      expect(dom.location.hash).toBe("#invalid");
      expect(view.getByRole("alert").textContent).toContain("invalid decryption key");
    } finally {
      cleanup(); open.mockRestore(); push.mockRestore();
      dom.history.replaceState(null, "", "/");
    }
  });

  test("browser back restores the recipient fragment and forward restores privacy", async () => {
    const { App } = await import("../../src/App");
    dom.history.replaceState(null, "", `/b/${id}#invalid`);
    const view = render(<App />);
    try {
      fireEvent.click(view.getByRole("link", { name: "Privacy" }));
      expect(dom.location.hash).toBe("");
      await act(async () => { dom.history.back(); await dom.happyDOM.waitUntilComplete(); });
      expect(dom.location.pathname).toBe(`/b/${id}`);
      expect(dom.location.hash).toBe("#invalid");
      expect(view.getByRole("alert").textContent).toContain("invalid decryption key");
      fireEvent.click(view.getByRole("link", { name: "Skip to content" }));
      expect(dom.location.hash).toBe("#invalid");
      expect(dom.document.title).toBe("Smallbin");
      await act(async () => { dom.history.forward(); await dom.happyDOM.waitUntilComplete(); });
      expect(dom.location.pathname).toBe("/privacy");
      expect(dom.document.title).toBe("Privacy | Smallbin");
      expect(view.getByRole("heading", { name: "Privacy", level: 1 })).toBeTruthy();
    } finally {
      view.unmount(); dom.history.replaceState(null, "", "/");
    }
  });

  test("New bin on the creation page keeps native reload behavior", async () => {
    const { App } = await import("../../src/App");
    dom.history.replaceState(null, "", "/");
    const config = spyOn(clientServices, "config").mockResolvedValue(defaultConfig);
    const open = spyOn(dom, "open").mockReturnValue(null);
    const push = spyOn(dom.history, "pushState");
    try {
      const view = render(<App />); await ready(view);
      fireEvent.change(view.getByLabelText(/Your message/), { target: { value: "reset this draft" } });
      const event = new dom.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      fireEvent(view.getByRole("link", { name: "New bin" }), event as unknown as Event);
      expect(event.defaultPrevented).toBe(false);
      expect(open).toHaveBeenCalledWith("https://smallbin.test/", "_self", "");
      expect(push).not.toHaveBeenCalled();
    } finally {
      cleanup(); config.mockRestore(); open.mockRestore(); push.mockRestore();
      dom.history.replaceState(null, "", "/");
    }
  });
});

test("multiple selections and drops append; each file can be removed while add remains available", async () => {
  const service = services();
  const view = render(<CreateBin services={service} />); await ready(view);
  const input = view.getByLabelText(/Attachment/) as HTMLInputElement;
  expect(input.multiple).toBe(true);
  const first = new File(["a"], "first.txt");
  const second = new File(["bb"], "second.txt");
  const third = new File(["ccc"], "third.txt");
  const fourth = new File(["dddd"], "fourth.txt");
  fireEvent.change(input, { target: { files: [first, second] } });
  fireEvent.change(input, { target: { files: [third] } });
  const add = view.getByRole("button", { name: /Drop more files/ });
  fireEvent.drop(add.parentElement!, { dataTransfer: { files: [fourth] } });
  expect(view.getAllByRole("listitem")).toHaveLength(4);
  expect(view.getByText("10 B / 100 MB total")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Remove second.txt, attachment 2" }));
  expect(view.queryByText("second.txt")).toBeNull();
  expect(view.getByText("8 B / 100 MB total")).toBeTruthy();
  expect(view.getByRole("button", { name: /Drop more files/ })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Create private link" }));
  await waitFor(() => expect(service.encrypt).toHaveBeenCalledWith({ text: "", files: [first, third, fourth] }));
});

test("accepts exactly 100 MB combined, rejects the whole oversized addition, and keeps the 1 MB text budget separate", async () => {
  const service = services();
  const view = render(<CreateBin services={service} />); await ready(view);
  const first = new File([], "first.bin"); Object.defineProperty(first, "size", { value: 60_000_000 });
  const second = new File([], "second.bin"); Object.defineProperty(second, "size", { value: 40_000_000 });
  fireEvent.change(view.getByLabelText(/Attachment/), { target: { files: [first, second] } });
  expect(view.getByText("100 MB / 100 MB total")).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  fireEvent.change(view.getByLabelText(/Attachment/), { target: { files: [new File([], "empty.txt"), new File(["x"], "overflow.txt")] } });
  expect(view.getByRole("alert").textContent).toContain("100 MB");
  expect(view.getAllByRole("listitem")).toHaveLength(2);
  expect(view.queryByText("empty.txt")).toBeNull();
  expect(view.queryByText("overflow.txt")).toBeNull();
  expect(service.encrypt).not.toHaveBeenCalled();
  expect(service.upload).not.toHaveBeenCalled();
  fireEvent.change(view.getByLabelText(/Your message/), { target: { value: "a".repeat(1_000_000) } });
  fireEvent.click(view.getByRole("button", { name: "Create private link" }));
  await waitFor(() => expect(service.encrypt).toHaveBeenCalledWith({ text: "a".repeat(1_000_000), files: [first, second] }));
});

test("duplicate filenames remain separate attachments and removing one preserves the other", async () => {
  const service = services();
  const view = render(<CreateBin services={service} />); await ready(view);
  const first = new File(["first"], "same.txt");
  const second = new File(["second"], "same.txt");
  fireEvent.change(view.getByLabelText(/Attachment/), { target: { files: [first, second] } });
  expect(view.getAllByText("same.txt")).toHaveLength(2);
  fireEvent.click(view.getByRole("button", { name: "Remove same.txt, attachment 1" }));
  expect(view.getAllByText("same.txt")).toHaveLength(1);
  fireEvent.click(view.getByRole("button", { name: "Create private link" }));
  await waitFor(() => expect(service.encrypt).toHaveBeenCalledWith({ text: "", files: [second] }));
});

test("metadata rejection leaves previously selected attachments intact", async () => {
  const service = services();
  const view = render(<CreateBin services={service} />); await ready(view);
  const first = new File(["keep"], "keep.txt");
  fireEvent.change(view.getByLabelText(/Attachment/), { target: { files: [first] } });
  const excessive = Array.from({ length: 10 }, (_, i) => new File([], `${i}-${"a".repeat(2_000)}.txt`));
  fireEvent.drop(view.getByRole("button", { name: /Drop more files/ }).parentElement!, { dataTransfer: { files: excessive } });
  expect(view.getByRole("alert").textContent).toContain("metadata");
  expect(view.getAllByRole("listitem")).toHaveLength(1);
  expect(view.getByText("keep.txt")).toBeTruthy();
  expect(service.encrypt).not.toHaveBeenCalled();
});

test("duplicate-name recipient attachments download individually with their own bytes", async () => {
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;
  const click = dom.HTMLAnchorElement.prototype.click;
  const blobs: Blob[] = [];
  const names: string[] = [];
  URL.createObjectURL = (blob: Blob) => { blobs.push(blob); return `blob:attachment-${blobs.length}`; };
  URL.revokeObjectURL = mock(() => {});
  dom.HTMLAnchorElement.prototype.click = function () { names.push(this.download); };
  try {
    const files = [
      { name: "../same.html", type: "text/html", bytes: new Uint8Array([11]) },
      { name: "../same.html", type: "text/html", bytes: new Uint8Array([22, 33]) },
    ];
    const service = services({ decrypt: mock(async () => ({ text: "", files })) });
    const view = render(<ReceiveBin id={id} secret={key} services={service} />);
    await waitFor(() => expect(view.getAllByRole("button", { name: /^Download/ })).toHaveLength(2));
    expect(blobs).toHaveLength(0);
    fireEvent.click(view.getByRole("button", { name: "Download ../same.html, attachment 2" }));
    expect([...new Uint8Array(await blobs[0]!.arrayBuffer())]).toEqual([22, 33]);
    fireEvent.click(view.getByRole("button", { name: "Download ../same.html, attachment 1" }));
    expect([...new Uint8Array(await blobs[1]!.arrayBuffer())]).toEqual([11]);
    expect(blobs.map(blob => blob.type)).toEqual(["application/octet-stream", "application/octet-stream"]);
    expect(names).toEqual(["_same.html", "_same.html"]);
    expect(view.queryByRole("button", { name: /Download all|ZIP/ })).toBeNull();
    view.unmount();
  } finally {
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    dom.HTMLAnchorElement.prototype.click = click;
  }
});
