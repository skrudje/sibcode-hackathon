import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, FileSpreadsheet, LoaderCircle, LogOut, ShieldCheck, Store, Upload } from "lucide-react";
import { api, type Schema, number, when } from "../api";
import { Button } from "./ui/button";
import { Failure } from "./integrations";
import { DesktopConnection } from "./desktop";
import "../brand-portal.css";

type Mapping = { phone: string; email: string; time: string };
const blank: Mapping = { phone: "", email: "", time: "" };
const names = { phone: "Телефон", email: "Email", time: "Время взаимодействия" };
const statuses = { queued: "В очереди", running: "Обрабатывается", succeeded: "Загружен", completed_with_errors: "Есть замечания", failed: "Ошибка" };

function guessedMapping(columns: Schema<"ImportColumn">[]): Mapping {
  const aliases = { phone: ["phone", "телефон", "мобильный", "мобильныйтелефон", "телефонклиента"],
    email: ["email", "почта", "электроннаяпочта"],
    time: ["time", "время", "дата", "датавремя", "датавзаимодействия", "датаоперации"] };
  const mapping = { ...blank };
  const used = new Set<number>();
  for (const field of ["phone", "email", "time"] as const) {
    const column = columns.find(c => !used.has(c.index) && aliases[field].includes(c.name.toLowerCase().replace(/[\s_.\-]/g, "")));
    if (column) { mapping[field] = String(column.index); used.add(column.index); }
  }
  return mapping;
}

export function BrandPortal({ user, onLogout, loggingOut, logoutError }: {
  user: Schema<"User">; onLogout: () => void; loggingOut: boolean; logoutError: unknown;
}) {
  const client = useQueryClient();
  const context = useQuery({ queryKey: ["brand-context"], queryFn: () => api<Schema<"BrandContext">>("/brand/context") });
  const [file, setFile] = useState<File | null>(null);
  const [structure, setStructure] = useState<Schema<"FilePreview"> | null>(null);
  const [mapping, setMapping] = useState<Mapping>({ ...blank });
  const [checked, setChecked] = useState<Schema<"FilePreview"> | null>(null);
  const [fileError, setFileError] = useState<Error | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [offset, setOffset] = useState(0);
  const [errorJob, setErrorJob] = useState<string | null>(null);
  const jobs = useQuery({ queryKey: ["brand-imports", offset], queryFn: () => api<Schema<"ImportJobPage">>(`/brand/imports?offset=${offset}`),
    enabled: !!context.data, refetchInterval: query => query.state.data?.items.some(j => ["queued", "running"].includes(j.status)) ? 2000 : 10000 });
  const errors = useQuery({ queryKey: ["brand-errors", errorJob], queryFn: () => api<Schema<"ImportErrorPage">>(`/brand/imports/${errorJob}/errors?limit=100`), enabled: !!errorJob });
  function form(selected: File, includeMapping: boolean) {
    const body = new FormData(); body.append("file", selected);
    if (includeMapping) body.append("mapping", JSON.stringify({ phone: mapping.phone === "" ? null : Number(mapping.phone),
      email: mapping.email === "" ? null : Number(mapping.email), time: Number(mapping.time) }));
    return body;
  }
  const inspect = useMutation({ mutationFn: (selected: File) => api<Schema<"FilePreview">>("/brand/imports/preview", { method: "POST", body: form(selected, false) }),
    onSuccess: data => { setStructure(data); setMapping(guessedMapping(data.columns)); } });
  const check = useMutation({ mutationFn: () => api<Schema<"FilePreview">>("/brand/imports/preview", { method: "POST", body: form(file!, true) }),
    onSuccess: data => setChecked(data) });
  const upload = useMutation({ mutationFn: () => api<Schema<"ImportJob">>("/brand/imports", { method: "POST", body: form(file!, true) }),
    onSuccess: async () => { setSubmitted(true); setOffset(0); await client.invalidateQueries({ queryKey: ["brand-imports"] }); } });
  const busy = inspect.isPending || check.isPending || upload.isPending;
  const selected = Object.values(mapping).filter(v => v !== "");
  const unique = new Set(selected).size === selected.length;
  const canCheck = mapping.time !== "" && (mapping.phone !== "" || mapping.email !== "") && unique;
  function choose(selectedFile: File | undefined) {
    if (!selectedFile) return;
    setFileError(null); setStructure(null); setChecked(null); setSubmitted(false); setErrorJob(null);
    inspect.reset(); check.reset(); upload.reset();
    if (!/\.(csv|xlsx)$/i.test(selectedFile.name) || selectedFile.size > 10 * 1024 * 1024) {
      setFile(null); setFileError(new Error("Выберите CSV или XLSX размером до 10 MiB")); return;
    }
    setFile(selectedFile); inspect.mutate(selectedFile);
  }
  function change(field: keyof Mapping, value: string) {
    setMapping(previous => ({ ...previous, [field]: value })); setChecked(null); setSubmitted(false); check.reset(); upload.reset();
  }
  return <div className="brand-portal">
    <header className="brand-portal-header"><div className="brand-portal-identity"><span className="brand-portal-icon"><Store size={24} /></span><div><strong>Кабинет бренда</strong><small>Хрюкерсы CDP · передача данных в ТЦ</small></div></div>
      <div className="brand-portal-account"><span>{user.email}</span><DesktopConnection label="Сервер" /><Button variant="outline" disabled={loggingOut} onClick={onLogout}><LogOut size={15} />Выйти</Button></div></header>
    <main className="brand-portal-content">
      <div className="page-heading"><div><h1>{context.data?.tenant_name ?? "Ваш магазин"}</h1><p>Загрузите таблицу и выберите, какие колонки использовать для истории взаимодействий.</p></div><span className="badge badge-green"><ShieldCheck size={14} />Только ваш магазин</span></div>
      <Failure error={context.error ?? logoutError} />
      {context.isPending && <div className="loading"><LoaderCircle className="spin" />Проверяем доступ к магазину…</div>}
      {context.data && <>
        <section className="panel brand-upload-panel"><div className="panel-heading"><div><h2>1. Выберите таблицу</h2><p>CSV или Excel XLSX · до 10 MiB · до 10 000 записей · заголовки в первой строке</p></div><FileSpreadsheet size={22} /></div>
          <div className="brand-upload-body"><label className={`brand-file-picker${busy ? " disabled" : ""}`}><Upload size={27} /><strong>{file?.name ?? "Выбрать CSV или Excel"}</strong><span>В Excel используется активный лист. CSV поддерживает запятую, точку с запятой и табуляцию.</span><input type="file" accept=".csv,.xlsx" aria-label="Таблица бренда" disabled={busy} onChange={event => { choose(event.target.files?.[0]); event.target.value = ""; }} /></label>
            <p className="brand-privacy">Файл передаётся серверу для предпросмотра. В импорт сохраняются только выбранные телефон, email и время — остальные колонки не сохраняются.</p>
            <Failure error={fileError ?? inspect.error} />{inspect.isPending && <div className="loading"><LoaderCircle className="spin" />Читаем структуру таблицы…</div>}
          </div></section>
        {structure && <section className="panel"><div className="panel-heading"><div><h2>2. Сопоставьте колонки</h2><p>{number(structure.total_rows)} записей{structure.sheet_name ? ` · лист «${structure.sheet_name}»` : ` · ${structure.encoding}`}</p></div></div>
          <div className="brand-mapping-grid">{(["phone", "email", "time"] as const).map(field => <label key={field}>{names[field]}{field === "time" && " *"}<select aria-label={`Колонка: ${names[field]}`} value={mapping[field]} disabled={busy} onChange={event => change(field, event.target.value)}><option value="">{field === "time" ? "Выберите колонку" : "Не передавать"}</option>{structure.columns.map(column => <option key={column.index} value={column.index}>{column.index + 1}. {column.name}</option>)}</select><small>{mapping[field] !== "" ? structure.columns[Number(mapping[field])]?.examples.filter(Boolean).slice(0, 2).join(" · ") || "Пустые значения" : field === "time" ? "Обязательно для каждой записи" : "Достаточно телефона или email"}</small></label>)}</div>
          <div className="brand-mapping-footer"><p>Для дат без часового пояса используем <strong>{structure.timezone}</strong>. Поддерживаются ISO 8601, ДД.ММ.ГГГГ ЧЧ:ММ и даты Excel.</p>{!unique && <div className="notice notice-error">Для каждого поля выберите отдельную колонку.</div>}<Failure error={check.error} /><Button disabled={!canCheck || busy} onClick={() => check.mutate()}>{check.isPending ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}Проверить выбранные данные</Button></div>
        </section>}
        {checked && <section className="panel"><div className="panel-heading"><div><h2>3. Проверьте и передайте данные</h2><p>Предпросмотр первых {checked.sample.length} записей. Конфликты профилей и повторы проверяются во время импорта.</p></div></div>
          <div className="brand-preview-counts"><span><strong>{number(checked.valid_rows ?? 0)}</strong> корректных записей</span><span><strong>{number(checked.invalid_rows ?? 0)}</strong> с ошибками</span></div>
          <div className="table-wrap"><table><thead><tr><th>№ записи</th><th>Телефон</th><th>Email</th><th>Время</th><th>Проверка</th></tr></thead><tbody>{checked.sample.map(row => <tr key={row.row_number}><td>{row.row_number}</td><td>{row.phone ?? "—"}</td><td>{row.email ?? "—"}</td><td>{row.time ?? "—"}</td><td>{row.error ? <span className="red-text">{row.error}</span> : <span className="brand-row-ok"><Check size={14} />Формат корректен</span>}</td></tr>)}</tbody></table></div>
          <div className="brand-mapping-footer">{!!checked.invalid_rows && <p>Строки с ошибками будут отклонены; корректные записи обработаются. Причины появятся в журнале ниже.</p>}<Failure error={upload.error} />
            {submitted ? <div className="notice"><Check size={17} />Загрузка создана. Следите за результатом в журнале своего магазина.</div> : <Button disabled={busy || !checked.valid_rows} onClick={() => upload.mutate()}>{upload.isPending ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}Передать {number(checked.total_rows)} записей</Button>}
          </div></section>}
        <section className="panel"><div className="panel-heading"><div><h2>История загрузок вашего магазина</h2><p>Повторные записи не дублируют историю. API и файлы показаны в одном журнале.</p></div></div><Failure error={jobs.error} />
          <div className="table-wrap"><table><thead><tr><th>Создана</th><th>Всего</th><th>Принято</th><th>Повторы</th><th>Отклонено</th><th>Статус</th></tr></thead><tbody>{jobs.data?.items.map(job => <tr key={job.id}><td>{when(job.created_at)}</td><td>{job.total_rows ?? "—"}</td><td>{job.accepted_rows}</td><td>{job.duplicate_rows}</td><td>{job.rejected_rows ? <button className="text-link" onClick={() => setErrorJob(job.id)}>{job.rejected_rows} · причины</button> : 0}</td><td><span className={`badge badge-${job.status === "succeeded" ? "green" : job.status === "failed" ? "red" : "gray"}`}>{statuses[job.status]}</span>{job.failure_message && <small className="red-text">{job.failure_message}</small>}</td></tr>)}</tbody></table></div>
          {jobs.isPending ? <div className="loading"><LoaderCircle className="spin" />Загружаем журнал…</div> : jobs.data && !jobs.data.total && <div className="empty"><FileSpreadsheet size={28} /><h3>Можно загрузить первую таблицу</h3><p>После передачи здесь появятся статус и результаты обработки.</p></div>}
          {jobs.data && jobs.data.total > 20 && <div className="pagination"><span>{offset + 1}–{Math.min(offset + 20, jobs.data.total)} из {jobs.data.total}</span><Button variant="outline" disabled={!offset || jobs.isFetching} onClick={() => setOffset(offset - 20)}>Назад</Button><Button variant="outline" disabled={offset + 20 >= jobs.data.total || jobs.isFetching} onClick={() => setOffset(offset + 20)}>Далее</Button></div>}
        </section>
        {errorJob && <section className="panel"><div className="panel-heading"><div><h2>Причины отклонения записей</h2><p>Номера соответствуют непустым записям таблицы, начиная с 1, без заголовка.</p></div><Button variant="ghost" onClick={() => setErrorJob(null)}>Закрыть</Button></div><Failure error={errors.error} /><div className="table-wrap"><table><thead><tr><th>№ записи</th><th>Что исправить</th></tr></thead><tbody>{errors.data?.items.map(row => <tr key={row.row_number}><td>{row.row_number}</td><td>{row.message}</td></tr>)}</tbody></table></div>{errors.data && errors.data.total > 100 && <p className="brand-privacy">Показаны первые 100 замечаний из {errors.data.total}.</p>}</section>}
      </>}
    </main>
  </div>;
}
