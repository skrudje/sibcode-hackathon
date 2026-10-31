import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, Check, LoaderCircle, RefreshCw, Server, Settings, Unplug } from "lucide-react";
import { api } from "../api";
import { checkConnection, connectServer, desktop, getConnection, saveExport } from "../transport";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

const ConnectionSwitch = createContext<(switching: boolean) => void>(() => {});

export function useConnectionHealth(enabled = true) {
  return useQuery({
    queryKey: ["connection-health"],
    queryFn: async ({ signal }) => {
      if (desktop) {
        await checkConnection();
        return { status: "ok" };
      }
      return api<{ status: string }>("/health/ready", { signal });
    },
    enabled,
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: desktop,
    retry: false,
  });
}

/** Keep connectivity checks and session switching independent of the current page. */
export function DesktopSession({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [switching, setSwitching] = useState(false);
  const health = useConnectionHealth(desktop && !switching);
  useEffect(() => {
    if (desktop && health.isSuccess) void client.invalidateQueries({
      predicate: query => query.queryKey[0] !== "connection-health"
        && !String(query.queryKey[0]).startsWith("desktop-")
        && query.state.status === "error",
    });
  }, [client, health.isSuccess, health.dataUpdatedAt]);
  useEffect(() => {
    if (!desktop) return;
    const failed = () => { void client.invalidateQueries({ queryKey: ["connection-health"] }); };
    window.addEventListener("connection-error", failed);
    return () => window.removeEventListener("connection-error", failed);
  }, [client]);
  if (!desktop) return children;
  return <ConnectionSwitch.Provider value={setSwitching}>
    <div inert={switching} aria-hidden={switching || undefined} style={switching ? { visibility: "hidden" } : undefined}>{children}</div>
    {switching && createPortal(<div className="desktop-switching" role="status"><LoaderCircle className="spin" size={23} />Проверяем сервер…</div>, document.body)}
  </ConnectionSwitch.Provider>;
}

export function DesktopConnection({ className = "desktop-settings", label = "Настройки" }: {
  className?: string;
  label?: string;
}) {
  const client = useQueryClient();
  const setSwitching = useContext(ConnectionSwitch);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [server, setServer] = useState("");
  const connection = useQuery({
    queryKey: ["desktop-connection"],
    queryFn: getConnection,
    enabled: desktop && open,
    staleTime: Infinity,
    retry: false,
  });
  const health = useConnectionHealth(desktop && open);
  const connect = useMutation({
    mutationFn: async () => {
      await client.cancelQueries();
      return connectServer(server.trim());
    },
    onMutate: () => setSwitching(true),
    onSuccess: next => {
      if (next.generation === connection.data?.generation) {
        setSwitching(false);
        setEditing(false);
        void health.refetch();
        return;
      }
      // Clear all cached data and page state before binding to the new session.
      client.clear();
      window.location.hash = "/";
      window.location.reload();
    },
    onError: () => setSwitching(false),
  });
  function close() {
    if (connect.isPending) return;
    setOpen(false);
    setEditing(false);
    connect.reset();
  }
  function edit() {
    setServer(connection.data?.serverUrl ?? "");
    connect.reset();
    setEditing(true);
  }
  if (!desktop) return null;
  return (
    <>
      <button className={className} type="button" aria-label={label} onClick={() => setOpen(true)} title={label}>
        <Settings size={17} /><span>{label}</span>
      </button>
      {open && (
        <Dialog title="Настройки приложения" onClose={close}>
          <div className="dialog-body connection-settings">
            <div className="settings-intro"><h3>Подключение</h3><p>Приложение автоматически использует сохранённый сервер вашей команды.</p></div>
            <div className={`settings-server${health.isError ? " settings-server-offline" : ""}`}>
              <span className="settings-server-icon"><Server size={21} /></span>
              <div><strong>Рабочая платформа</strong><span>{health.isError ? "Нет связи с сервером" : health.isPending ? "Проверяем доступность…" : "Сервер доступен"}</span></div>
              {health.isError ? <Unplug size={18} /> : health.isPending ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />}
            </div>
            <Button type="button" variant="outline" disabled={health.isFetching || connect.isPending} onClick={() => void health.refetch()}><RefreshCw size={14} />Проверить подключение</Button>
            {connection.isError && <div role="alert" className="notice notice-error">Не удалось прочитать настройки. <button type="button" className="text-link" onClick={() => void connection.refetch()}>Повторить</button></div>}
            {!editing ? (
              <>
                <div className="settings-option"><div><strong>Сервер команды</strong><small>Меняйте адрес только при переходе на другую платформу.</small></div><Button type="button" variant="outline" disabled={!connection.data} onClick={edit}>Изменить сервер</Button></div>
                <div className="form-actions"><Button type="button" onClick={close}>Готово</Button></div>
              </>
            ) : (
              <form className="settings-server-form" onSubmit={(event) => {
                event.preventDefault();
                // Saving an unchanged address must not reset the native session.
                if (connection.data && new URL(server.trim()).href === new URL(connection.data.serverUrl).href) {
                  setEditing(false);
                  connect.reset();
                  return;
                }
                connect.mutate();
              }}>
                <label>Адрес сервера<input autoFocus type="url" required value={server} disabled={connect.isPending} onChange={(event) => { setServer(event.target.value); connect.reset(); }} placeholder="https://cdp.example.com" /></label>
                <p>Адрес выдаёт администратор вашей команды. После смены сервера потребуется войти заново.</p>
                <details><summary>Локальная разработка</summary><p>Если сервер запущен через Docker на этом компьютере: <code>http://127.0.0.1:5180</code>.</p></details>
                {connect.error && <div role="alert" className="notice notice-error">{connect.error.message}</div>}
                <div className="form-actions"><Button variant="outline" type="button" onClick={() => { setEditing(false); connect.reset(); }} disabled={connect.isPending}>Отмена</Button><Button disabled={connect.isPending}>{connect.isPending && <LoaderCircle className="spin" size={16} />}{connect.isPending ? "Подключаемся…" : "Сохранить и подключиться"}</Button></div>
              </form>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}

export function ConnectionUnavailable({ checking, onRetry }: { checking: boolean; onRetry: () => void }) {
  const health = useConnectionHealth(false);
  return (
    <main className="connection-unavailable">
      <div className="connection-recovery">
        <span className="connection-recovery-icon"><Unplug size={29} /></span>
        <div className="eyebrow">NEXA</div>
        <h1>Не удалось подключиться</h1>
        <p>Платформа сейчас недоступна. Проверьте подключение к сети и попробуйте ещё раз.</p>
        <Button onClick={() => { void health.refetch(); onRetry(); }} disabled={checking}><RefreshCw size={16} className={checking ? "spin" : ""} />{checking ? "Подключаемся…" : "Повторить"}</Button>
        <DesktopConnection label="Настройки подключения" />
      </div>
    </main>
  );
}

export function ExportDownload({ id, url }: { id: string; url: string }) {
  const download = useMutation({ mutationFn: () => saveExport(id) });
  return (
    <>
      {desktop ? <button type="button" className="text-link" disabled={download.isPending} onClick={() => download.mutate()} aria-busy={download.isPending}>
        {download.isPending ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}
        Скачать CSV
      </button> : <a className="text-link" href={url} download><ArrowDownToLine size={15} /> Скачать CSV</a>}
      {download.error && <small role="alert">{download.error.message}</small>}
      {!download.isPending && download.data === true && <small role="status">CSV сохранён</small>}
      {!download.isPending && download.data === false && <small role="status">Сохранение отменено. Выгрузку можно скачать повторно.</small>}
    </>
  );
}
