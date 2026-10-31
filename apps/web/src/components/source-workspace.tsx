import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Cable, Check, FileSpreadsheet, LoaderCircle, Upload } from "lucide-react";
import { api, type Schema, waitImport, when } from "../api";
import { Failure, useConnections } from "./integrations";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { HelpTip } from "./ui/help-tip";

export function SourceWorkspace() {
  const client = useQueryClient();
  const sources = useConnections();
  const [offset, setOffset] = useState(0);
  const [errorJob, setErrorJob] = useState<string | null>(null);
  const jobs = useQuery({ queryKey: ["imports", offset], queryFn: () => api<Schema<"ImportJobPage">>(`/imports?offset=${offset}`), refetchInterval: query => query.state.data?.items.some(job => ["queued", "running"].includes(job.status)) ? 2000 : 10_000 });
  const errors = useQuery({ queryKey: ["import-errors", errorJob], queryFn: () => api<Schema<"ImportErrorPage">>(`/imports/${errorJob}/errors?limit=100`), enabled: !!errorJob });
  const upload = useMutation({ mutationFn: async ({ id, file }: { id: string; file: File }) => {
    if (file.size > 10 * 1024 * 1024) throw new Error("Максимальный размер файла — 10 MiB");
    const form = new FormData(); form.append("file", file);
    const job = await api<Schema<"ImportJob">>(`/sources/${id}/imports`, { method: "POST", body: form });
    await client.invalidateQueries({ queryKey: ["imports"] });
    await waitImport(job.id);
  }, onSettled: () => void client.invalidateQueries() });
  const status = { queued: "В очереди", running: "Обработка", succeeded: "Загружен", completed_with_errors: "Есть замечания", failed: "Ошибка" };
  return <>
    <div className="page-heading"><div><h1>Источники данных</h1><p>Взаимодействия клиентов: телефон, email и время. Один формат для всех арендаторов.</p></div><div className="heading-actions"><Button asChild variant="outline"><Link to="/integrations"><Cable size={16} />Интеграции и расписания</Link></Button></div></div>
    <div className="integration-explainer"><span className="integration-symbol"><FileSpreadsheet size={24} /></span><div><strong>Файлы нужны для первой загрузки и разового дополнения</strong><p>Основной поток получает записи по API автоматически. Для CSV и Excel используйте одинаковые колонки: <code>phone</code>, <code>email</code>, <code>time</code>. Достаточно телефона или email; время обязательно, с часовым поясом.</p><details><summary>Посмотреть формат файла</summary><pre>phone,email,time{"\n"}+79131234567,visitor@example.invalid,2026-10-30T12:00:00+07:00</pre><p>CSV: UTF-8, разделитель — запятая. Excel: заголовки на первой строке активного листа. До 10 MiB и 10 000 записей.</p></details></div></div>
    <Failure error={sources.error ?? jobs.error ?? upload.error} />
    {upload.isPending && <div className="notice" role="status"><LoaderCircle size={16} className="spin" />Файл обрабатывается на сервере. Результат появится в журнале.</div>}
    {upload.isSuccess && <div className="notice" role="status"><Check size={16} />Файл обработан. Результаты и замечания — в журнале ниже.</div>}
    <div className="connection-cards">{sources.data?.items.map(source => <section className="panel connection-card" key={source.id}><div className="connection-card-top"><span className="source-icon crm_csv">{source.enabled ? <Cable size={20} /> : <FileSpreadsheet size={20} />}</span><span className={`badge badge-${source.last_error ? "amber" : source.enabled ? "green" : "gray"}`}>{source.last_error ? "Есть замечания" : source.enabled ? "Автозагрузка" : "Ручная загрузка"}</span></div><h2>{source.tenant_name}</h2><p>{source.category}</p><dl><div><dt>Последняя загрузка</dt><dd>{when(source.last_success_at)}</dd></div><div><dt>Полнота истории <HelpTip term="Полнота истории" /></dt><dd>{source.coverage_from && source.coverage_to ? `${when(source.coverage_from)} — ${when(source.coverage_to)}` : "Период не указан"}</dd></div></dl><label className="btn btn-outline connection-file"><Upload size={14} />Загрузить CSV или Excel<input type="file" aria-label={`Файл ${source.tenant_name}`} accept=".csv,.xlsx" disabled={upload.isPending} onChange={event => { const file = event.target.files?.[0]; if (file) upload.mutate({ id: source.id, file }); event.target.value = ""; }} /></label></section>)}</div>
    <section className="panel"><div className="panel-heading"><div><h2>Журнал загрузок</h2><p>Ручные файлы и автоматические обращения к API обрабатываются одинаково</p></div></div><div className="table-wrap"><table><thead><tr><th>Арендатор / дата</th><th>Всего</th><th>Принято</th><th>Дубли <HelpTip term="Дубли" text="Такие же контакты и время уже были загружены из этого источника. Повтор не создаёт новое взаимодействие." /></th><th>Отклонено</th><th>Статус</th></tr></thead><tbody>{jobs.data?.items.map(job => <tr key={job.id}><td><strong>{sources.data?.items.find(source => source.id === job.source_id)?.tenant_name ?? "Источник"}</strong><small>{when(job.created_at)}</small></td><td>{job.total_rows ?? "—"}</td><td>{job.accepted_rows}</td><td>{job.duplicate_rows}</td><td>{job.rejected_rows ? <button className="text-link amber-text" onClick={() => setErrorJob(job.id)}>{job.rejected_rows} · причины</button> : "—"}</td><td><span className={`badge badge-${job.status === "succeeded" ? "green" : job.status === "failed" ? "red" : "gray"}`}>{["queued", "running"].includes(job.status) && <LoaderCircle size={12} className="spin" />}{status[job.status]}</span>{job.failure_message && <small className="red-text">{job.failure_message}</small>}</td></tr>)}</tbody></table></div>{jobs.data && !jobs.data.total && <div className="empty"><FileSpreadsheet size={25} /><h3>Загрузок пока нет</h3><p>Загрузите файл или настройте автоматическое получение записей.</p><Link to="/integrations" className="text-link">Открыть интеграции <ArrowRight size={14} /></Link></div>}{jobs.data && jobs.data.total > 20 && <div className="pagination"><span>{offset+1}–{Math.min(offset+20,jobs.data.total)} из {jobs.data.total}</span><div><Button size="sm" variant="outline" disabled={!offset} onClick={() => setOffset(offset-20)}>Назад</Button><Button size="sm" variant="outline" disabled={offset+20 >= jobs.data.total} onClick={() => setOffset(offset+20)}>Далее</Button></div></div>}</section>
    {errorJob && <Dialog title="Замечания к загрузке" onClose={() => setErrorJob(null)}><div className="dialog-body"><Failure error={errors.error} /><table><thead><tr><th>Запись</th><th>Что исправить</th></tr></thead><tbody>{errors.data?.items.map(error => <tr key={error.row_number}><td>{error.row_number}</td><td>{error.message}</td></tr>)}</tbody></table></div></Dialog>}
  </>;
}
