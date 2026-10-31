import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, Check, LoaderCircle, RefreshCw, Server, Settings, Unplug } from "lucide-react";
import { api } from "../api";
import { connectServer, desktop, getConnection, saveExport } from "../transport";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

export function DesktopConnection({ className = "desktop-settings", label = "Настройки" }: {
  className?: string;
  label?: string;
}) {
  const client = useQueryClient();
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
  const health = useQuery({
    queryKey: ["connection-health"],
    queryFn: () => api<{ status: string }>("/health/ready"),
    enabled: desktop && open,
    staleTime: 10_000,
    retry: false,
  });
  const connect = useMutation({
    mutationFn: () => connectServer(server.trim()),
    onSuccess: async () => {
      // Cancel old-server queries before removing cached profiles and sessions.
      await client.cancelQueries();
      client.clear();
      window.location.hash = "/";
      window.location.reload();
    },
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
  return (
    <main className="connection-unavailable">
      <div className="connection-recovery">
        <span className="connection-recovery-icon"><Unplug size={29} /></span>
        <div className="eyebrow">Хрюкерсы CDP</div>
        <h1>Не удалось подключиться</h1>
        <p>Платформа сейчас недоступна. Проверьте подключение к сети и попробуйте ещё раз.</p>
        <Button onClick={onRetry} disabled={checking}><RefreshCw size={16} className={checking ? "spin" : ""} />{checking ? "Подключаемся…" : "Повторить"}</Button>
        <DesktopConnection label="Настройки подключения" />
      </div>
    </main>
  );
}

export function ExportDownload({ id, url }: { id: string; url: string }) {
  const download = useMutation({ mutationFn: () => saveExport(id) });
  return (
    <>
      <a className="text-link" href={url} download onClick={(event) => {
        if (desktop) { event.preventDefault(); if (!download.isPending) download.mutate(); }
      }} aria-busy={download.isPending}>
        {download.isPending ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}
        Скачать CSV
      </a>
      {download.error && <small role="alert">{download.error.message}</small>}
      {download.data === true && <small role="status">CSV сохранён</small>}
    </>
  );
}
