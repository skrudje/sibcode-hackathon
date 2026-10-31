import { invoke, isTauri } from "@tauri-apps/api/core";

export const desktop = isTauri();

function base64(bytes: Uint8Array) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 32768)
    text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}

type NativeResponse = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};

/** Same API contract, with cookie ownership in Rust when running in Tauri. */
export async function platformFetch(path: string, options: RequestInit = {}) {
  if (!desktop) return fetch(path, options);
  const request = new Request(`http://localhost${path}`, options);
  const bytes = new Uint8Array(await request.arrayBuffer());
  try {
    const connection = await getConnection();
    const response = await invoke<NativeResponse>("desktop_request", {
      generation: connection.generation,
      request: {
        path,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        bodyBase64: bytes.length ? base64(bytes) : null,
      },
    });
    const data = Uint8Array.from(atob(response.bodyBase64), (c) => c.charCodeAt(0));
    return new Response(data.length ? data : null, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    window.dispatchEvent(new Event("connection-error"));
    throw new Error(
      typeof error === "string" ? error : "Не удалось подключиться к серверу",
    );
  }
}

export type ConnectionInfo = { serverUrl: string; generation: number };
// Bind this webview's requests to one native session until the page is reloaded.
let connection: Promise<ConnectionInfo> | undefined;
export const getConnection = () => connection ??= invoke<ConnectionInfo>("desktop_connection").catch((error: unknown) => {
  connection = undefined;
  throw error;
});
export const checkConnection = async () => invoke<void>("desktop_check", { generation: (await getConnection()).generation });
export const connectServer = async (serverUrl: string) =>
  invoke<ConnectionInfo>("desktop_connect", { serverUrl, generation: (await getConnection()).generation }).catch((error: unknown) => {
    throw new Error(typeof error === "string" ? error : "Не удалось подключиться");
  });
export const saveExport = async (exportId: string) =>
  invoke<boolean>("desktop_save_export", { exportId, generation: (await getConnection()).generation }).catch((error: unknown) => {
    throw new Error(typeof error === "string" ? error : "Не удалось сохранить CSV");
  });
