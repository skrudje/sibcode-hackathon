import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, LoaderCircle, Monitor, Server } from "lucide-react";
import { connectServer, desktop, getConnection, saveExport } from "../transport";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

export function DesktopConnection() {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [server, setServer] = useState("");
  const [current, setCurrent] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (desktop)
      void getConnection().then((info) => {
        setServer(info.serverUrl);
        setCurrent(info.serverUrl);
      }).catch(() => setError("Не удалось прочитать настройки подключения"));
  }, []);
  const connect = useMutation({
    mutationFn: () => connectServer(server),
    onSuccess: (info) => {
      setCurrent(info.serverUrl);
      // Cancel old-server queries before removing cached profiles and sessions.
      void client.cancelQueries().then(() => {
        client.clear();
        window.location.hash = "/";
        window.location.reload();
      });
    },
  });
  if (!desktop) return null;
  return (
    <>
      <button className="desktop-connection" aria-label="Подключение к серверу" onClick={() => setOpen(true)} title={current}>
        <Monitor size={13} /><span>Подключение к серверу</span>
      </button>
      {open && (
        <Dialog title="Подключение к платформе" onClose={() => !connect.isPending && setOpen(false)}>
          <form className="dialog-body" onSubmit={(event) => { event.preventDefault(); connect.mutate(); }}>
            <p>Укажите сервер вашей команды. При смене сервера потребуется войти заново.</p>
            <label>Адрес сервера
              <input type="url" required value={server} onChange={(event) => setServer(event.target.value)} placeholder="https://cdp.example.com" />
            </label>
            <small>Для локального Docker: http://127.0.0.1:5180. Сервер должен быть запущен.</small>
            {(error || connect.error) && <div role="alert" className="notice notice-error">{connect.error?.message || error}</div>}
            <div className="form-actions">
              <Button variant="outline" type="button" onClick={() => setOpen(false)} disabled={connect.isPending}>Отмена</Button>
              <Button disabled={connect.isPending}>{connect.isPending ? <LoaderCircle className="spin" size={16} /> : <Server size={16} />} Проверить и подключить</Button>
            </div>
          </form>
        </Dialog>
      )}
    </>
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
