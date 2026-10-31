import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, CircleCheck, CircleAlert, LoaderCircle, Monitor, RefreshCw, Server } from "lucide-react";
import { checkConnection, connectServer, desktop, getConnection, saveExport } from "../transport";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

export function DesktopConnection({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [server, setServer] = useState("");
  const [switching, setSwitching] = useState(false);
  const info = useQuery({ queryKey: ["desktop-connection"], queryFn: getConnection, enabled: desktop, retry: false, staleTime: Infinity });
  const health = useQuery({
    queryKey: ["desktop-health"],
    queryFn: async () => { await checkConnection(); return true; },
    enabled: desktop && !!info.data && !switching,
    retry: false,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    if (health.isSuccess) void client.invalidateQueries({ predicate: (query) => !String(query.queryKey[0]).startsWith("desktop-") && query.state.status === "error" });
  }, [health.isSuccess, client]);
  useEffect(() => {
    const failed = () => { void client.invalidateQueries({ queryKey: ["desktop-health"] }); };
    window.addEventListener("connection-error", failed);
    return () => window.removeEventListener("connection-error", failed);
  }, [client]);
  const connect = useMutation({
    mutationFn: async () => {
      await client.cancelQueries();
      return connectServer(server);
    },
    onMutate: () => setSwitching(true),
    onSuccess: (next) => {
      if (next.generation === info.data?.generation) {
        setOpen(false);
        void health.refetch();
        return;
      }
      client.clear();
      // Unmount all page state and bind the reloaded webview to the new native session.
      window.location.hash = "/";
      window.location.reload();
    },
    onSettled: () => setSwitching(false),
  });
  if (!desktop) return children;
  const busy = info.isPending || health.isFetching;
  const unavailable = !!(info.error || health.error);
  const status = busy ? "Проверяем подключение…" : unavailable ? "Сервер недоступен" : "Сервер доступен";
  return (
    <div className={`desktop-shell ${unavailable ? "connection-unavailable" : ""}`}>
      <div className={`connection-bar ${unavailable ? "connection-offline" : ""}`}>
        <span role="status" className="connection-status">
          {busy ? <LoaderCircle className="spin" size={16} /> : unavailable ? <CircleAlert size={16} /> : <CircleCheck size={16} />}
          {status}
        </span>
        <span className="connection-address" title={info.data?.serverUrl}>{info.data?.serverUrl || "Адрес не прочитан"}</span>
        <Button size="sm" variant="outline" disabled={busy || switching} onClick={() => {
          if (!info.data) void info.refetch();
          else void health.refetch();
        }}><RefreshCw size={14} /> Повторить попытку</Button>
        <Button size="sm" variant="outline" disabled={switching} onClick={() => {
          setServer(info.data?.serverUrl || "");
          connect.reset();
          setOpen(true);
        }}><Monitor size={14} /> Подключение к серверу</Button>
      </div>
      {unavailable && <div className="connection-explanation">Проверьте сеть и адрес сервера. Данные на экране могут быть устаревшими. {String((info.error || health.error) instanceof Error ? (info.error || health.error)!.message : info.error || health.error)}</div>}
      {switching ? <div className="loading" role="status"><LoaderCircle className="spin" size={23} /> Проверяем сервер…</div> : children}
      {open && (
        <Dialog title="Подключение к платформе" onClose={() => !connect.isPending && setOpen(false)}>
          <form className="dialog-body" onSubmit={(event) => { event.preventDefault(); connect.mutate(); }}>
            <p>Укажите сервер вашей команды. При смене сервера профили на экране и сессия очищаются, потребуется войти заново.</p>
            <label>Адрес сервера
              <input type="url" required disabled={connect.isPending} value={server} onChange={(event) => setServer(event.target.value)} placeholder="https://cdp.example.com" />
            </label>
            <small>Для локального Docker: http://127.0.0.1:5180. Для удалённого сервера нужен HTTPS.</small>
            {connect.error && <div role="alert" className="notice notice-error">{connect.error.message}</div>}
            <div className="form-actions">
              <Button variant="outline" type="button" onClick={() => setOpen(false)} disabled={connect.isPending}>Отмена</Button>
              <Button disabled={connect.isPending || !info.data}>{connect.isPending ? <LoaderCircle className="spin" size={16} /> : <Server size={16} />} Проверить и подключить</Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
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
