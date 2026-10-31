import { useEffect, useState, type ReactNode } from "react";
import {
  Link,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronLeft,
  CircleAlert,
  Clapperboard,
  Database,
  FileSpreadsheet,
  Filter,
  GitBranch,
  Link2,
  LoaderCircle,
  Mail,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
  Utensils,
  X,
} from "lucide-react";
import {
  api,
  ApiError,
  type Campaign,
  type Customer,
  type ImportJob,
  type Rule,
  type Schema,
  type Segment,
  type Source,
  type Tenant,
  eventNames,
  exampleImport,
  number,
  reasonNames,
  sourceNames,
  uploadFile,
  useData,
  waitImport,
  when,
} from "./api";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { ConnectionUnavailable, DesktopConnection, ExportDownload } from "./components/desktop";
import { Workspace } from "./components/workspace";
import { VisitRadar } from "./components/radar";


function Message({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`notice ${error ? "notice-error" : ""}`}
      role={error ? "alert" : undefined}
    >
      <CircleAlert size={17} />
      <span>{children}</span>
    </div>
  );
}
function ErrorMessage({ error }: { error: unknown }) {
  return error ? (
    <Message error>
      {error instanceof Error ? error.message : "Не удалось загрузить данные"}
    </Message>
  ) : null;
}
function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={23} />
      <span>Загружаем данные…</span>
    </div>
  );
}
function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Database size={25} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
function Badge({
  children,
  tone = "gray",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
function Title({
  eyebrow,
  title,
  text,
  actions,
}: {
  eyebrow?: string;
  title: string;
  text: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      <div className="heading-actions">{actions}</div>
    </div>
  );
}
function Panel({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <div className="panel-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span className={`avatar ${small ? "avatar-sm" : ""}`}>
      {name.replace("Посетитель ", "П").slice(0, 2).toUpperCase()}
    </span>
  );
}
function IdentityBadge({ status }: { status: string }) {
  return status === "verified" ? (
    <Badge tone="green">
      <ShieldCheck size={12} /> Подтверждён
    </Badge>
  ) : (
    <Badge tone="amber">Один источник</Badge>
  );
}
function StatusBadge({ job }: { job: ImportJob }) {
  const labels = {
    queued: "В очереди",
    running: "Обработка",
    succeeded: "Загружен",
    completed_with_errors: "Есть замечания",
    failed: "Ошибка",
  };
  return (
    <Badge
      tone={
        job.status === "succeeded"
          ? "green"
          : job.status === "failed"
            ? "red"
            : job.status === "completed_with_errors"
              ? "amber"
              : "blue"
      }
    >
      {["running", "queued"].includes(job.status) && (
        <LoaderCircle size={12} className="spin" />
      )}
      {labels[job.status]}
    </Badge>
  );
}
function Pagination({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  return (
    <div className="pagination">
      <span>
        {total
          ? `${offset + 1}–${Math.min(offset + 20, total)} из ${total}`
          : "Нет записей"}
      </span>
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={!offset}
          onClick={() => onChange(offset - 20)}
        >
          Назад
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={offset + 20 >= total}
          onClick={() => onChange(offset + 20)}
        >
          Далее
        </Button>
      </div>
    </div>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState("marketer@example.com"),
    [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    onSuccess: onLogin,
  });
  return (
    <div className="login-page">
      <main className="login-form">
        <div className="login-mark"><span className="brand-icon"><Link2 size={23} /></span><strong>Хрюкерсы</strong><span>CDP</span></div>
        <h2>Добро пожаловать</h2>
        <p>Войдите в рабочее пространство торгового центра</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            Пароль
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              placeholder="Введите пароль"
            />
          </label>
          <ErrorMessage error={mutation.error} />
          <Button disabled={mutation.isPending} className="full">
            {mutation.isPending ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              "Войти в платформу"
            )}
            <ArrowRight size={17} />
          </Button>
        </form>
        <div className="login-note">
          <ShieldCheck size={15} /> Демонстрационная среда · Синтетические данные
        </div>
      </main>
      <div className="login-version"><span>Клиентская платформа · SibКод 2026 · 0.1.0</span><DesktopConnection /></div>
    </div>
  );
}

export default function App() {
  const client = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Schema<"User">>("/auth/me"),
    retry: false,
  });
  useEffect(() => {
    const expired = () => {
      client.clear();
      void me.refetch();
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, [client, me.refetch]);
  if (me.isPending) return <Loading />;
  if (!me.data && me.isError && !(me.error instanceof ApiError && me.error.status === 401))
    return <ConnectionUnavailable checking={me.isFetching} onRetry={() => void me.refetch()} />;
  if (!me.data)
    return (
      <Login
        onLogin={() => {
          void client.invalidateQueries({ queryKey: ["me"] });
        }}
      />
    );
  return <Layout email={me.data.email} />;
}

function Layout({ email }: { email: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [help, setHelp] = useState(false);
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    onSuccess: () => {
      client.clear();
      client.setQueryData(["me"], null);
      navigate("/", { replace: true });
    },
  });
  return (
    <Workspace email={email} onHelp={() => setHelp(true)} onLogout={() => logout.mutate()} loggingOut={logout.isPending}>
      <ErrorMessage error={logout.error} />
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/sources" element={<Sources />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/customers/:id" element={<CustomerProfile />} />
        <Route path="/segments" element={<Segments />} />
        <Route path="/recommendations" element={<Recommendations />} />
        <Route path="/campaigns" element={<Campaigns />} />
        <Route path="/radar" element={<VisitRadar />} />
        <Route path="*" element={<Empty title="Страница не найдена" text="Выберите раздел в меню слева." />} />
      </Routes>
      {help && (
        <Dialog
          title="От данных — к следующему визиту"
          onClose={() => setHelp(false)}
        >
          <div className="dialog-body">
            <p>
              Платформа объединяет события трёх арендаторов по подтверждённому
              общему ключу. Сегменты учитывают период наблюдения и полноту
              доступной истории.
            </p>
            <ol className="help-steps">
              <li>Загрузите API кинотеатра, Excel кафе и CSV книжного.</li>
              <li>Откройте профиль G001 и проверьте историю.</li>
              <li>Посмотрите сегмент и объяснение рекомендации книжного C.</li>
              <li>Создайте CSV-выгрузку кампании.</li>
              <li>
                Загрузите дополнительную покупку G001 в C — рекомендация
                исчезнет.
              </li>
            </ol>
            <Message>
              Выгрузка не отправляет сообщения. Демо использует синтетические
              контакты.
            </Message>
            <Button asChild>
              <Link to="/sources" onClick={() => setHelp(false)}>
                Перейти к источникам
                <ArrowRight size={16} />
              </Link>
            </Button>
          </div>
        </Dialog>
      )}
    </Workspace>
  );
}

function useDemo() {
  const client = useQueryClient(),
    [step, setStep] = useState("");
  const mutation = useMutation({
    mutationFn: async () => {
      const sources = await api<Schema<"SourcePage">>("/sources");
      const order = { rest_api: 0, pos_xlsx: 1, crm_csv: 2 };
      for (const source of sources.items.sort(
        (a, b) => order[a.kind] - order[b.kind],
      )) {
        setStep(source.name);
        const job = await exampleImport(source);
        await waitImport(job.id);
        await client.invalidateQueries();
      }
    },
    onSuccess: () => {
      setStep("");
      void client.invalidateQueries();
    },
  });
  return { ...mutation, step };
}

function Overview() {
  const summary = useData<Schema<"Summary">>(["summary"], "/summary"),
    sources = useData<Schema<"SourcePage">>(["sources"], "/sources"),
    customers = useData<Schema<"CustomerPage">>(
      ["recent-customers"],
      "/customers?limit=4",
    ),
    demo = useDemo();
  const data = summary.data;
  return (
    <>
      <Title
        title="Обзор платформы"
        text="Состояние клиентской базы и загрузок ТЦ «Орбита»"
        actions={
          <>
            <Button variant="outline" disabled={demo.isPending} onClick={() => demo.mutate()}>
              {demo.isPending ? <LoaderCircle size={15} className="spin" /> : <Database size={15} />}
              {demo.isPending ? demo.step : data?.customer_count ? "Повторить демозагрузку" : "Запустить демосценарий"}
            </Button>
            <Button asChild><Link to="/sources"><Upload size={15} /> Загрузить данные</Link></Button>
            <Button asChild variant="outline"><Link to="/radar"><Sparkles size={15} /> Радар новых визитов</Link></Button>
          </>
        }
      />
      <ErrorMessage error={summary.error ?? demo.error} />
      <div className="metrics">
        {[
          {
            label: "Единых профилей",
            value: data?.customer_count,
            icon: Users,
            hint: "Клиенты всех арендаторов",
            tone: "blue",
          },
          {
            label: "Событий в истории",
            value: data?.event_count,
            icon: GitBranch,
            hint: "Визиты, покупки и брони",
            tone: "purple",
          },
          {
            label: "Подтверждённых профилей",
            value: data?.verified_customer_count,
            icon: ShieldCheck,
            hint: "Связаны общим клиентским ключом",
            tone: "green",
          },
          {
            label: "Источников данных",
            value: data?.source_count,
            icon: Database,
            hint: "CRM, касса и REST API",
            tone: "orange",
          },
        ].map(({ label, value, icon: Icon, hint, tone }) => (
          <div className="metric" key={label}>
            <div className="metric-top">
              <span>{label}</span>
              <span className={`metric-icon ${tone}`}>
                <Icon size={19} />
              </span>
            </div>
            <strong>{value === undefined ? "—" : number(value)}</strong>
            <small>{hint}</small>
          </div>
        ))}
      </div>
      <div className="overview-grid">
        <Panel
          title="Последние загрузки"
          subtitle="Результаты последних заданий импорта"
          action={
            <Link className="text-link" to="/sources">
              Все источники
              <ArrowRight size={15} />
            </Link>
          }
        >
          {data?.last_imports.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Источник</th>
                    <th>Принято</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {data.last_imports.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <strong>
                          {sources.data?.items.find(
                            (s) => s.id === job.source_id,
                          )?.name ?? "Источник"}
                        </strong>
                        <small>{when(job.created_at)}</small>
                      </td>
                      <td>{job.accepted_rows}</td>
                      <td>
                        <StatusBadge job={job} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : summary.isPending ? (
            <Loading />
          ) : (
            <Empty
              title="История начинается с данных"
              text="Запустите демосценарий или загрузите файлы арендаторов."
              action={
                <Button variant="outline" asChild>
                  <Link to="/sources">
                    Подключить источники
                    <ArrowRight size={15} />
                  </Link>
                </Button>
              }
            />
          )}
        </Panel>
        <Panel
          title="Качество идентификации"
          subtitle="Объединяем только подтверждённые связи"
        >
          <div className="quality">
            <div
              className="quality-ring"
              style={
                {
                  "--progress": `${data?.customer_count ? (data.verified_customer_count / data.customer_count) * 100 : 0}%`,
                } as React.CSSProperties
              }
            >
              <div>
                <strong>
                  {data?.customer_count
                    ? Math.round(
                        (data.verified_customer_count / data.customer_count) *
                          100,
                      )
                    : 0}
                  %
                </strong>
                <span>подтверждено</span>
              </div>
            </div>
            <div className="legend">
              <div>
                <span>
                  <i className="dot dot-blue" />
                  Единый ключ
                </span>
                <strong>{data?.verified_customer_count ?? 0}</strong>
              </div>
              <div>
                <span>
                  <i className="dot dot-gray" />
                  Один источник
                </span>
                <strong>{data?.source_only_customer_count ?? 0}</strong>
              </div>
            </div>
            <p>
              Совпадение имени или контакта не объединяет профили автоматически.
            </p>
          </div>
        </Panel>
      </div>
      <Panel
        title="Клиенты вашего ТЦ"
        subtitle="Один профиль — события разных арендаторов"
        action={
          <Link className="text-link" to="/customers">
            Все клиенты
            <ArrowRight size={15} />
          </Link>
        }
      >
        {customers.data?.items.length ? (
          <CustomerTable customers={customers.data.items} />
        ) : (
          <div className="inline-empty">
            После первой загрузки здесь появятся профили посетителей.
          </div>
        )}
      </Panel>
    </>
  );
}

function CustomerTable({ customers }: { customers: Customer[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Клиент</th>
            <th>Единый ключ</th>
            <th>Идентификация</th>
            <th>Создан</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.id}>
              <td>
                <Link to={`/customers/${c.id}`} className="person">
                  <Avatar name={c.display_name ?? "Клиент"} small />
                  <span>
                    <strong>{c.display_name ?? "Без имени"}</strong>
                    <small>Посетитель ТЦ</small>
                  </span>
                </Link>
              </td>
              <td>
                <code>{c.global_customer_key ?? "Нет общего ключа"}</code>
              </td>
              <td>
                <IdentityBadge status={c.identity_status} />
              </td>
              <td className="muted">{when(c.created_at)}</td>
              <td>
                <Link
                  to={`/customers/${c.id}`}
                  className="table-link"
                  aria-label={`Открыть ${c.global_customer_key ?? "профиль"}`}
                >
                  <ArrowUpRight size={18} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sources() {
  const client = useQueryClient(),
    [errorJob, setErrorJob] = useState<string | null>(null),
    [offset, setOffset] = useState(0);
  const sources = useData<Schema<"SourcePage">>(["sources"], "/sources"),
    tenants = useData<Schema<"TenantPage">>(["tenants"], "/tenants"),
    demo = useDemo();
  const jobs = useQuery({
    queryKey: ["imports", offset],
    queryFn: () => api<Schema<"ImportJobPage">>(`/imports?offset=${offset}`),
    refetchInterval: (q) =>
      q.state.data?.items.some((j) => ["queued", "running"].includes(j.status))
        ? 2000
        : false,
  });
  useEffect(() => {
    if (
      jobs.data?.items.some((j) => !["queued", "running"].includes(j.status))
    ) {
      void client.invalidateQueries({ queryKey: ["summary"] });
      void client.invalidateQueries({ queryKey: ["sources"] });
      void client.invalidateQueries({ queryKey: ["customers"] });
    }
  }, [jobs.data, client]);
  const mutation = useMutation({
    mutationFn: async ({
      source,
      file,
      followup,
    }: {
      source: Source;
      file?: File;
      followup?: boolean;
    }) => {
      const job = file
        ? await uploadFile(source, file, file.name)
        : await exampleImport(source, followup);
      await client.invalidateQueries({ queryKey: ["imports"] });
      await waitImport(job.id);
    },
    onSuccess: () => {
      void client.invalidateQueries();
    },
  });
  const errors = useData<Schema<"ImportErrorPage">>(
    ["import-errors", errorJob],
    `/imports/${errorJob}/errors?limit=100`,
    !!errorJob,
  );
  const names = (id: string) =>
    tenants.data?.items.find((t) => t.id === id)?.name ?? "Арендатор";
  return (
    <>
      <Title
        title="Источники данных"
        text="Подключения арендаторов, загрузка файлов и журнал обработки"
        actions={
          <Button
            disabled={demo.isPending || mutation.isPending}
            onClick={() => demo.mutate()}
          >
            {demo.isPending ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Plus size={16} />
            )}{" "}
            Загрузить демоданные
          </Button>
        }
      />
      <ErrorMessage error={sources.error ?? mutation.error ?? demo.error} />
      {demo.isPending && (
        <Message>
          Загружаем источник: {demo.step}. Результаты появятся в журнале ниже.
        </Message>
      )}
      <div className="source-grid">
        {sources.data?.items.map((source) => {
          const Icon =
            source.kind === "rest_api"
              ? Clapperboard
              : source.kind === "pos_xlsx"
                ? Utensils
                : BookOpen;
          return (
            <Panel key={source.id} className="source-card">
              <div className="source-card-top">
                <span className={`source-icon ${source.kind}`}>
                  <Icon size={24} />
                </span>
                <Badge tone={source.last_success_at ? "green" : "gray"}>
                  {source.last_success_at ? (
                    <>
                      <Check size={12} /> Данные загружены
                    </>
                  ) : (
                    "Ожидает загрузки"
                  )}
                </Badge>
              </div>
              <h2>{names(source.tenant_id)}</h2>
              <p>{source.name}</p>
              <span className="format-tag">
                <FileSpreadsheet size={14} />
                {sourceNames[source.kind]}
              </span>
              <div className="source-details">
                <span>
                  Последняя загрузка
                  <strong>{when(source.last_success_at)}</strong>
                </span>
                <span>
                  История доступна с
                  <strong>{when(source.coverage_from)}</strong>
                </span>
              </div>
              <Button
                variant="outline"
                className="full"
                disabled={mutation.isPending || demo.isPending}
                onClick={() => mutation.mutate({ source })}
              >
                {source.kind === "rest_api" ? (
                  <>
                    <Link2 size={16} />
                    Синхронизировать API
                  </>
                ) : (
                  <>
                    <Database size={16} />
                    Загрузить пример
                  </>
                )}
              </Button>
              {source.kind !== "rest_api" && (
                <label className="upload-link">
                  <Upload size={14} />
                  Выбрать свой файл
                  <input
                    type="file"
                    aria-label={`Файл ${source.name}`}
                    accept={source.kind === "pos_xlsx" ? ".xlsx" : ".csv"}
                    disabled={mutation.isPending}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) mutation.mutate({ source, file });
                      e.target.value = "";
                    }}
                  />
                </label>
              )}
            </Panel>
          );
        })}
      </div>
      <Message>
        Полнота истории задаётся источником. Отсутствие записи означает «нет
        зарегистрированного события», а не доказанное отсутствие визита.
      </Message>
      <Panel
        title="Журнал загрузок"
        subtitle="Каждая принятая строка сохраняет свой источник и результат обработки"
      >
        {jobs.isPending ? (
          <Loading />
        ) : jobs.data?.items.length ? (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Источник / дата</th>
                    <th>Всего</th>
                    <th>Принято</th>
                    <th>Дубли</th>
                    <th>Отклонено</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.data.items.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <strong>
                          {
                            sources.data?.items.find(
                              (s) => s.id === job.source_id,
                            )?.name
                          }
                        </strong>
                        <small>{when(job.created_at)}</small>
                      </td>
                      <td>{job.total_rows ?? "—"}</td>
                      <td className="green-text">{job.accepted_rows}</td>
                      <td>{job.duplicate_rows}</td>
                      <td>
                        {job.rejected_rows ? (
                          <button
                            className="text-link amber-text"
                            onClick={() => setErrorJob(job.id)}
                          >
                            {job.rejected_rows} · открыть
                          </button>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <StatusBadge job={job} />
                        {job.failure_message && (
                          <small className="red-text">
                            {job.failure_message}
                          </small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              offset={offset}
              total={jobs.data.total}
              onChange={setOffset}
            />
          </>
        ) : (
          <Empty
            title="Пока нет загрузок"
            text="Синхронизируйте API или загрузите CSV и Excel. Мы покажем результат каждой строки."
          />
        )}
      </Panel>
      <div className="followup-box">
        <div>
          <GitBranch size={21} />
          <span>
            <strong>Проверить изменение рекомендации</strong>
            <small>
              Добавьте покупку посетителя G001 в книжном C после основного
              импорта.
            </small>
          </span>
        </div>
        <Button
          variant="outline"
          disabled={mutation.isPending || !jobs.data?.items.length}
          onClick={() => {
            const source = sources.data?.items.find(
              (s) => s.kind === "crm_csv",
            );
            if (source) mutation.mutate({ source, followup: true });
          }}
        >
          Добавить покупку в C<ArrowRight size={16} />
        </Button>
      </div>
      {errorJob && (
        <Dialog title="Замечания к загрузке" onClose={() => setErrorJob(null)}>
          <div className="dialog-body">
            {errors.isPending ? (
              <Loading />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Строка</th>
                    <th>Причина</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.data?.items.map((e) => (
                    <tr key={e.row_number}>
                      <td>{e.row_number}</td>
                      <td>
                        <strong>{e.message}</strong>
                        <small>{e.code}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <ErrorMessage error={errors.error} />
          </div>
        </Dialog>
      )}
    </>
  );
}

function Customers() {
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState(""),
    [offset, setOffset] = useState(0);
  const data = useData<Schema<"CustomerPage">>(
    ["customers", search, filter, offset],
    `/customers?offset=${offset}&q=${encodeURIComponent(search)}${filter ? `&identity_status=${filter}` : ""}`,
  );
  return (
    <>
      <Title
        title="Клиенты"
        text="Профили посетителей и события из всех источников"
        actions={<Badge tone="blue">{data.data?.total ?? "—"} профилей</Badge>}
      />
      <Panel className="customer-browser">
        <div className="table-toolbar">
          <label className="search-input">
            <Search size={18} />
            <input
              aria-label="Поиск клиентов"
              placeholder="Поиск по имени, ключу или контакту"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
          </label>
          <div className="filter-control">
            <Filter size={16} />
            <select
              aria-label="Идентификация"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">Все профили</option>
              <option value="verified">Подтверждённые</option>
              <option value="source_only">Один источник</option>
            </select>
          </div>
        </div>
        <ErrorMessage error={data.error} />
        {data.isPending ? (
          <Loading />
        ) : data.data?.items.length ? (
          <>
            <CustomerTable customers={data.data.items} />
            <Pagination
              offset={offset}
              total={data.data.total}
              onChange={setOffset}
            />
          </>
        ) : (
          <Empty
            title="Профили не найдены"
            text="Измените поиск или загрузите данные арендаторов."
          />
        )}
      </Panel>
      <Message>
        Общий клиентский ключ связывает данные источников. Одинаковые имена и
        email сами по себе не доказывают, что это один человек.
      </Message>
    </>
  );
}

function CustomerProfile() {
  const { id } = useParams(),
    [offset, setOffset] = useState(0);
  const profile = useData<Schema<"CustomerDetail">>(
      ["customer", id],
      `/customers/${id}`,
    ),
    events = useData<Schema<"EventPage">>(
      ["events", id, offset],
      `/customers/${id}/events?offset=${offset}`,
    ),
    recs = useData<Schema<"RecommendationResult">>(
      ["recs", id],
      `/customers/${id}/recommendations`,
    ),
    tenants = useData<Schema<"TenantPage">>(["tenants"], "/tenants"),
    sources = useData<Schema<"SourcePage">>(["sources"], "/sources");
  const customer = profile.data;
  if (profile.isPending) return <Loading />;
  if (!customer) return <ErrorMessage error={profile.error} />;
  return (
    <>
      <Link className="back-link" to="/customers">
        <ChevronLeft size={16} />
        Все клиенты
      </Link>
      <div className="profile-heading">
        <Avatar name={customer.display_name ?? "Клиент"} />
        <div>
          <div className="eyebrow">ЕДИНЫЙ ПРОФИЛЬ</div>
          <h1>{customer.display_name ?? "Без имени"}</h1>
          <div className="profile-meta">
            <code>{customer.global_customer_key ?? "Нет общего ключа"}</code>
            <IdentityBadge status={customer.identity_status} />
            <span>
              {customer.event_count} событий ·{" "}
              {customer.external_identities.length} внешних ID
            </span>
          </div>
        </div>
      </div>
      <div className="profile-grid">
        <div>
          <Panel
            title="Лента событий"
            subtitle="Каждое событие — с датой и источником"
          >
            {events.isPending ? (
              <Loading />
            ) : (
              <>
                <div className="timeline">
                  {events.data?.items.map((event) => {
                    const tenant = tenants.data?.items.find(
                      (t) => t.id === event.tenant_id,
                    );
                    const Icon =
                      event.event_type === "purchase"
                        ? BookOpen
                        : event.event_type === "booking"
                          ? Clapperboard
                          : Check;
                    return (
                      <div className="timeline-event" key={event.id}>
                        <div className={`event-icon event-${event.event_type}`}>
                          <Icon size={20} />
                        </div>
                        <div>
                          <div className="timeline-title">
                            <strong>{eventNames[event.event_type]}</strong>
                            <span>
                              {event.amount
                                ? `${number(Number(event.amount))} ₽`
                                : ""}
                            </span>
                          </div>
                          <p>{tenant?.name}</p>
                          <small>
                            {when(event.occurred_at)} ·{" "}
                            {
                              sources.data?.items.find(
                                (s) => s.id === event.source_id,
                              )?.name
                            }
                          </small>
                          <code className="event-id">
                            {event.external_event_id}
                          </code>
                        </div>
                      </div>
                    );
                  })}
                  {!events.data?.total && (
                    <div className="inline-empty">Пока нет событий</div>
                  )}
                </div>
                <Pagination
                  offset={offset}
                  total={events.data?.total ?? 0}
                  onChange={setOffset}
                />
              </>
            )}
          </Panel>
          <Panel
            title="Контакты и происхождение"
            subtitle="Сохраняем различия между источниками"
          >
            {customer.contact_conflicts.length > 0 && (
              <div className="panel-padding">
                <Message error>
                  Конфликт каналов: {customer.contact_conflicts.join(", ")}.
                  Выгрузка по конфликтующему каналу будет исключена.
                </Message>
              </div>
            )}
            <div className="contact-list">
              {customer.contacts.map((contact) => (
                <div key={contact.id}>
                  <span className="contact-icon">
                    <Mail size={17} />
                  </span>
                  <div>
                    <strong>{contact.value}</strong>
                    <small>
                      {contact.channel} ·{" "}
                      {
                        sources.data?.items.find(
                          (s) => s.id === contact.source_id,
                        )?.name
                      }
                    </small>
                  </div>
                  {!contact.normalized_value && (
                    <Badge tone="amber">Проверьте формат</Badge>
                  )}
                </div>
              ))}
              {!customer.contacts.length && (
                <p className="muted">Контакты не переданы источниками.</p>
              )}
            </div>
          </Panel>
        </div>
        <div>
          <Panel
            title="Следующий шаг"
            subtitle="Персональная рекомендация"
            className="recommendation-panel"
          >
            {recs.isPending ? (
              <Loading />
            ) : recs.data?.items.length ? (
              recs.data.items.map((rec) => (
                <div className="recommendation" key={rec.rule_id}>
                  <div className="recommendation-icon">
                    <BookOpen size={29} />
                  </div>
                  <Badge tone="blue">Новое место в доступной истории</Badge>
                  <h2>{rec.destination_tenant_name}</h2>
                  <p className="offer-title">{rec.offer_title}</p>
                  <p>{rec.offer_description}</p>
                  <div className="reason-box">
                    <Sparkles size={17} />
                    <div>
                      <strong>Почему это предложение</strong>
                      <p>{rec.explanation}</p>
                    </div>
                  </div>
                  <span className="muted small">
                    Срез: {when(recs.data?.as_of)} · КРСК
                  </span>
                  <Button asChild className="full">
                    <Link to="/campaigns">
                      Перейти к кампании
                      <ArrowUpRight size={16} />
                    </Link>
                  </Button>
                </div>
              ))
            ) : (
              <div className="recommendation-empty">
                <CheckCheck size={35} />
                <h3>Подходящего предложения пока нет</h3>
                <p>
                  {reasonNames[recs.data?.empty_reason ?? "no_matching_rules"]}
                </p>
              </div>
            )}
            <ErrorMessage error={recs.error} />
          </Panel>
          <Panel title="Связи профиля">
            <div className="identity-list">
              {customer.external_identities.map((identity) => (
                <div
                  key={`${identity.source_id}-${identity.external_customer_id}`}
                >
                  <Link2 size={16} />
                  <div>
                    <strong>
                      {
                        sources.data?.items.find(
                          (s) => s.id === identity.source_id,
                        )?.name
                      }
                    </strong>
                    <code>{identity.external_customer_id}</code>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

function ConditionEditor({
  title,
  conditions,
  tenants,
  onChange,
}: {
  title: string;
  conditions: Schema<"EventCondition">[];
  tenants: Tenant[];
  onChange: (conditions: Schema<"EventCondition">[]) => void;
}) {
  return (
    <div className="condition-group">
      <div>
        <strong>{title}</strong>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={conditions.length >= 5}
          onClick={() =>
            onChange([
              ...conditions,
              { tenant_id: tenants[0]?.id ?? "", event_types: ["purchase"] },
            ])
          }
        >
          <Plus size={14} />
          Условие
        </Button>
      </div>
      {conditions.map((condition, i) => (
        <div className="condition-row" key={i}>
          <select
            aria-label={`${title} арендатор ${i + 1}`}
            required
            value={condition.tenant_id}
            onChange={(e) =>
              onChange(
                conditions.map((c, j) =>
                  j === i ? { ...c, tenant_id: e.target.value } : c,
                ),
              )
            }
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <div className="type-checks">
            {(["visit", "purchase", "booking"] as const).map((type) => (
              <label key={type}>
                <input
                  type="checkbox"
                  checked={condition.event_types.includes(type)}
                  onChange={(e) =>
                    onChange(
                      conditions.map((c, j) =>
                        j === i
                          ? {
                              ...c,
                              event_types: e.target.checked
                                ? [...c.event_types, type]
                                : c.event_types.filter((t) => t !== type),
                            }
                          : c,
                      ),
                    )
                  }
                />
                {eventNames[type]}
              </label>
            ))}
          </div>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label="Удалить условие"
            onClick={() => onChange(conditions.filter((_, j) => j !== i))}
          >
            <X size={16} />
          </Button>
        </div>
      ))}
    </div>
  );
}

function SegmentForm({
  initial,
  tenants,
  onClose,
}: {
  initial: Segment | null;
  tenants: Tenant[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const tenantId = (code: string) =>
    tenants.find((t) => t.code === code)?.id ?? tenants[0]?.id ?? "";
  const [name, setName] = useState(initial?.name ?? ""),
    [days, setDays] = useState(initial?.definition.lookback_days ?? 90),
    [include, setInclude] = useState<Schema<"EventCondition">[]>(
      initial?.definition.include_all ?? [
        { tenant_id: tenantId("A"), event_types: ["visit"] },
        { tenant_id: tenantId("B"), event_types: ["purchase"] },
      ],
    ),
    [exclude, setExclude] = useState<Schema<"EventCondition">[]>(
      initial?.definition.exclude_any ?? [
        { tenant_id: tenantId("C"), event_types: ["purchase"] },
      ],
    );
  const mutation = useMutation({
    mutationFn: () =>
      api(`/segments${initial ? `/${initial.id}` : ""}`, {
        method: initial ? "PUT" : "POST",
        body: JSON.stringify({
          name,
          definition: {
            lookback_days: days,
            include_all: include,
            exclude_any: exclude,
            require_verified_identity: true,
            require_complete_coverage: true,
          },
        }),
      }),
    onSuccess: () => {
      void client.invalidateQueries();
      onClose();
    },
  });
  return (
    <Dialog
      title={initial ? "Редактировать сегмент" : "Новый сегмент"}
      onClose={onClose}
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <label>
          Название сегмента
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            placeholder="Например: кино и кафе без покупки в книжном"
          />
        </label>
        <label>
          Период истории, дней
          <input
            type="number"
            min="1"
            max="365"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            required
          />
        </label>
        <ConditionEditor
          title="Все эти события есть"
          conditions={include}
          tenants={tenants}
          onChange={setInclude}
        />
        <ConditionEditor
          title="Ни одного из этих событий нет"
          conditions={exclude}
          tenants={tenants}
          onChange={setExclude}
        />
        <Message>
          Учитываются подтверждённые профили и полностью покрытый период
          истории. Состояние unknown не включается в аудиторию.
        </Message>
        <ErrorMessage error={mutation.error} />
        <div className="form-actions">
          <Button type="button" variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={mutation.isPending}>Сохранить сегмент</Button>
        </div>
      </form>
    </Dialog>
  );
}

function Segments() {
  const segments = useData<Schema<"SegmentPage">>(["segments"], "/segments"),
    tenants = useData<Schema<"TenantPage">>(["tenants"], "/tenants");
  const [selected, setSelected] = useState(""),
    [edit, setEdit] = useState<Segment | null | undefined>(),
    [offset, setOffset] = useState(0);
  const sid = selected || segments.data?.items[0]?.id,
    segment = segments.data?.items.find((s) => s.id === sid);
  const members = useData<Schema<"SegmentMemberPage">>(
    ["members", sid, offset],
    `/segments/${sid}/members?offset=${offset}`,
    !!sid,
  );
  const tenantName = (id: string) =>
    tenants.data?.items.find((t) => t.id === id)?.name ?? id;
  return (
    <>
      <Title
        title="Сегменты"
        text="Понятные условия. Проверяемая аудитория. Полная история."
        actions={
          <Button disabled={!tenants.data} onClick={() => setEdit(null)}>
            <Plus size={17} />
            Создать сегмент
          </Button>
        }
      />
      <ErrorMessage error={segments.error ?? members.error} />
      <div className="selection-layout">
        <aside className="selection-list">
          {segments.data?.items.map((s) => (
            <button
              key={s.id}
              className={`selection-card ${sid === s.id ? "selected" : ""}`}
              onClick={() => {
                setSelected(s.id);
                setOffset(0);
              }}
            >
              <span className="selection-icon">
                <GitBranch size={20} />
              </span>
              <strong>{s.name}</strong>
              <small>
                {s.definition.lookback_days} дней ·{" "}
                {s.definition.include_all.length +
                  s.definition.exclude_any.length}{" "}
                условий
              </small>
              <ArrowUpRight size={16} />
            </button>
          ))}
        </aside>
        <div>
          {segment ? (
            <>
              <Panel
                title={segment.name}
                subtitle={`Срез: ${when(members.data?.evaluation.as_of)} · КРСК`}
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEdit(segment)}
                  >
                    Редактировать
                  </Button>
                }
              >
                <div className="condition-summary">
                  {segment.definition.include_all.map((c, i) => (
                    <div key={`include-${i}`}>
                      <Badge tone="green">ЕСТЬ</Badge>
                      <span>{tenantName(c.tenant_id)}</span>
                      <small>
                        {c.event_types.map((t) => eventNames[t]).join(" / ")}
                      </small>
                    </div>
                  ))}
                  {segment.definition.exclude_any.map((c, i) => (
                    <div key={`exclude-${i}`}>
                      <Badge tone="blue">НЕТ ЗАПИСИ</Badge>
                      <span>{tenantName(c.tenant_id)}</span>
                      <small>
                        {c.event_types.map((t) => eventNames[t]).join(" / ")}
                      </small>
                    </div>
                  ))}
                </div>
                <div className="segment-counts">
                  {[
                    [
                      "В аудитории",
                      members.data?.evaluation.eligible_count,
                      "blue",
                    ],
                    [
                      "Не подходят",
                      members.data?.evaluation.ineligible_count,
                      "gray",
                    ],
                    [
                      "Недостаточно данных",
                      members.data?.evaluation.unknown_count,
                      "amber",
                    ],
                  ].map(([label, value, tone]) => (
                    <div key={String(label)}>
                      <span className={`dot dot-${tone}`} />
                      <strong>{value ?? "—"}</strong>
                      <small>{label}</small>
                    </div>
                  ))}
                </div>
              </Panel>
              <Panel
                title="Клиенты сегмента"
                subtitle="Только подтверждённое соответствие всем условиям"
              >
                {members.isPending ? (
                  <Loading />
                ) : members.data?.items.length ? (
                  <>
                    <CustomerTable customers={members.data.items} />
                    <Pagination
                      offset={offset}
                      total={members.data.total}
                      onChange={setOffset}
                    />
                  </>
                ) : (
                  <Empty
                    title="Сейчас нет подходящих клиентов"
                    text="Загрузите события или проверьте условия и покрытие истории."
                  />
                )}
              </Panel>
              <Message>
                Unknown означает, что данных недостаточно. Такие профили не
                считаются уверенно подходящими для приглашения.
              </Message>
            </>
          ) : segments.isPending ? (
            <Loading />
          ) : (
            <Empty
              title="Создайте первый сегмент"
              text="Выберите сочетание арендаторов и событий, которое нужно найти."
            />
          )}
        </div>
      </div>
      {edit !== undefined && (
        <SegmentForm
          initial={edit}
          tenants={tenants.data?.items ?? []}
          onClose={() => setEdit(undefined)}
        />
      )}
    </>
  );
}

function localDateTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function RuleForm({
  initial,
  segments,
  tenants,
  onClose,
}: {
  initial: Rule | null;
  segments: Segment[];
  tenants: Tenant[];
  onClose: () => void;
}) {
  const client = useQueryClient(),
    [values, setValues] = useState({
      name: initial?.name ?? "",
      segment_id: initial?.segment_id ?? segments[0]?.id ?? "",
      destination_tenant_id:
        initial?.destination_tenant_id ??
        tenants.find((t) => t.code === "C")?.id ??
        "",
      priority: initial?.priority ?? 80,
      offer_title: initial?.offer_title ?? "",
      offer_description: initial?.offer_description ?? "",
      valid_from: localDateTime(
        initial?.valid_from ?? new Date().toISOString(),
      ),
      valid_until: localDateTime(
        initial?.valid_until ??
          new Date(Date.now() + 30 * 86400000).toISOString(),
      ),
      is_active: initial?.is_active ?? true,
    });
  const mutation = useMutation({
    mutationFn: () =>
      api(`/recommendation-rules${initial ? `/${initial.id}` : ""}`, {
        method: initial ? "PUT" : "POST",
        body: JSON.stringify({
          ...values,
          valid_from: new Date(values.valid_from).toISOString(),
          valid_until: new Date(values.valid_until).toISOString(),
        }),
      }),
    onSuccess: () => {
      void client.invalidateQueries();
      onClose();
    },
  });
  return (
    <Dialog
      title={
        initial ? "Редактировать рекомендацию" : "Новое правило рекомендации"
      }
      onClose={onClose}
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <label>
          Название правила
          <input
            value={values.name}
            onChange={(e) => setValues({ ...values, name: e.target.value })}
            required
            maxLength={120}
          />
        </label>
        <div className="form-grid">
          <label>
            Сегмент
            <select
              value={values.segment_id}
              onChange={(e) =>
                setValues({ ...values, segment_id: e.target.value })
              }
              required
            >
              {segments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Куда приглашаем
            <select
              value={values.destination_tenant_id}
              onChange={(e) =>
                setValues({ ...values, destination_tenant_id: e.target.value })
              }
              required
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Заголовок предложения
          <input
            value={values.offer_title}
            onChange={(e) =>
              setValues({ ...values, offer_title: e.target.value })
            }
            required
            maxLength={160}
          />
        </label>
        <label>
          Описание
          <textarea
            value={values.offer_description}
            onChange={(e) =>
              setValues({ ...values, offer_description: e.target.value })
            }
            maxLength={1000}
            rows={3}
          />
        </label>
        <div className="form-grid">
          <label>
            Действует с
            <input
              type="datetime-local"
              value={values.valid_from}
              onChange={(e) =>
                setValues({ ...values, valid_from: e.target.value })
              }
              required
            />
          </label>
          <label>
            Действует до
            <input
              type="datetime-local"
              value={values.valid_until}
              onChange={(e) =>
                setValues({ ...values, valid_until: e.target.value })
              }
              required
            />
          </label>
        </div>
        <div className="form-grid">
          <label>
            Бизнес-приоритет · 1–100
            <input
              type="number"
              min="1"
              max="100"
              value={values.priority}
              onChange={(e) =>
                setValues({ ...values, priority: Number(e.target.value) })
              }
              required
            />
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={values.is_active}
              onChange={(e) =>
                setValues({ ...values, is_active: e.target.checked })
              }
            />
            Правило активно
          </label>
        </div>
        <Message>
          Арендатор назначения должен быть исключён по покупкам в выбранном
          сегменте. Приоритет задаётся маркетологом и не является вероятностью
          покупки.
        </Message>
        <ErrorMessage error={mutation.error} />
        <div className="form-actions">
          <Button type="button" variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={mutation.isPending}>Сохранить правило</Button>
        </div>
      </form>
    </Dialog>
  );
}

function Recommendations() {
  const rules = useData<Schema<"RecommendationRulePage">>(
      ["rules"],
      "/recommendation-rules",
    ),
    segments = useData<Schema<"SegmentPage">>(["segments"], "/segments"),
    tenants = useData<Schema<"TenantPage">>(["tenants"], "/tenants"),
    [edit, setEdit] = useState<Rule | null | undefined>();
  return (
    <>
      <Title
        title="Рекомендации"
        text="Объяснимые правила, которые находят подходящий следующий шаг."
        actions={
          <Button
            disabled={!segments.data?.total}
            onClick={() => setEdit(null)}
          >
            <Plus size={17} />
            Добавить правило
          </Button>
        }
      />
      <ErrorMessage error={rules.error} />
      <div className="rule-grid">
        {rules.data?.items.map((rule) => (
          <Panel key={rule.id} className="rule-card">
            <div className="source-card-top">
              <span className="source-icon crm_csv">
                <Sparkles size={24} />
              </span>
              <Badge
                tone={
                  rule.is_active && new Date(rule.valid_until) > new Date()
                    ? "green"
                    : "gray"
                }
              >
                {rule.is_active && new Date(rule.valid_until) > new Date()
                  ? "Активно"
                  : "Неактивно"}
              </Badge>
            </div>
            <h2>{rule.name}</h2>
            <div className="rule-destination">
              {
                tenants.data?.items.find(
                  (t) => t.id === rule.destination_tenant_id,
                )?.name
              }
              <ArrowUpRight size={18} />
            </div>
            <p>{rule.offer_title}</p>
            <p className="muted">{rule.offer_description}</p>
            <div className="rule-meta">
              <span>
                Аудитория
                <strong>
                  {
                    segments.data?.items.find((s) => s.id === rule.segment_id)
                      ?.name
                  }
                </strong>
              </span>
              <span>
                Приоритет<strong>{rule.priority} / 100</strong>
              </span>
              <span>
                Действует до<strong>{when(rule.valid_until)}</strong>
              </span>
            </div>
            <Button
              variant="outline"
              className="full"
              onClick={() => setEdit(rule)}
            >
              Редактировать правило
            </Button>
          </Panel>
        ))}
      </div>
      {rules.data && !rules.data.total && (
        <Empty
          title="Пока нет правил"
          text="Создайте сегмент и добавьте предложение подходящего арендатора."
        />
      )}
      <Message>
        Каждая рекомендация в профиле содержит реальные события и период, за
        который нет зарегистрированной покупки. Пустой результат тоже
        объясняется.
      </Message>
      {edit !== undefined && (
        <RuleForm
          initial={edit}
          segments={segments.data?.items ?? []}
          tenants={tenants.data?.items ?? []}
          onClose={() => setEdit(undefined)}
        />
      )}
    </>
  );
}

function CampaignForm({
  segments,
  rules,
  onClose,
  onCreated,
}: {
  segments: Segment[];
  rules: Rule[];
  onClose: () => void;
  onCreated: (campaign: Campaign) => void;
}) {
  const [name, setName] = useState(""),
    [ruleId, setRuleId] = useState(rules[0]?.id ?? ""),
    [channel, setChannel] = useState("email");
  const chosen = rules.find((r) => r.id === ruleId);
  const mutation = useMutation({
    mutationFn: () =>
      api<Campaign>("/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name,
          recommendation_rule_id: ruleId,
          segment_id: chosen?.segment_id,
          channel,
        }),
      }),
    onSuccess: onCreated,
  });
  return (
    <Dialog title="Новая кампания" onClose={onClose}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <label>
          Название
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            placeholder="Например: знакомство с книжным"
          />
        </label>
        <label>
          Правило рекомендации
          <select
            value={ruleId}
            onChange={(e) => setRuleId(e.target.value)}
            required
          >
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <div className="field-hint">
          Сегмент:{" "}
          {segments.find((s) => s.id === chosen?.segment_id)?.name ??
            "Выберите правило"}
        </div>
        <label>
          Канал выгрузки
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="push">Push</option>
          </select>
        </label>
        <Message>
          Будет создан CSV для внешней системы. Платформа не отправляет
          сообщения.
        </Message>
        <ErrorMessage error={mutation.error} />
        <div className="form-actions">
          <Button type="button" variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={mutation.isPending}>Создать кампанию</Button>
        </div>
      </form>
    </Dialog>
  );
}

function Campaigns() {
  const [searchParams] = useSearchParams();
  const client = useQueryClient(),
    campaigns = useData<Schema<"CampaignPage">>(["campaigns"], "/campaigns"),
    segments = useData<Schema<"SegmentPage">>(["segments"], "/segments"),
    rules = useData<Schema<"RecommendationRulePage">>(
      ["rules"],
      "/recommendation-rules",
    );
  const [selected, setSelected] = useState(searchParams.get("campaign") ?? ""),
    [create, setCreate] = useState(false),
    [key, setKey] = useState(() => crypto.randomUUID());
  const cid = selected || campaigns.data?.items[0]?.id,
    campaign = campaigns.data?.items.find((c) => c.id === cid);
  const preview = useData<Schema<"ExportPreview">>(
      ["preview", cid],
      `/campaigns/${cid}/preview`,
      !!cid,
    ),
    exports = useData<Schema<"ExportPage">>(
      ["exports", cid],
      `/campaigns/${cid}/exports`,
      !!cid,
    );
  const mutation = useMutation({
    mutationFn: () =>
      api<Schema<"Export">>(`/campaigns/${cid}/exports`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
      }),
    onSuccess: () => {
      setKey(crypto.randomUUID());
      void client.invalidateQueries();
    },
  });
  return (
    <>
      <Title
        title="Кампании"
        text="Подготовьте релевантную аудиторию и передайте её в маркетинг."
        actions={
          <Button disabled={!rules.data?.total} onClick={() => setCreate(true)}>
            <Plus size={17} />
            Создать кампанию
          </Button>
        }
      />
      <ErrorMessage
        error={campaigns.error ?? preview.error ?? mutation.error}
      />
      <div className="selection-layout">
        <aside className="selection-list">
          {campaigns.data?.items.map((c) => (
            <button
              key={c.id}
              className={`selection-card ${cid === c.id ? "selected" : ""}`}
              onClick={() => {
                setSelected(c.id);
                setKey(crypto.randomUUID());
                mutation.reset();
              }}
            >
              <span className="selection-icon">
                <Send size={20} />
              </span>
              <strong>{c.name}</strong>
              <small>
                {c.channel.toUpperCase()} · {when(c.created_at)}
              </small>
              <ArrowUpRight size={16} />
            </button>
          ))}
        </aside>
        <div>
          {campaign ? (
            <>
              <Panel
                title={campaign.name}
                subtitle={`Канал: ${campaign.channel.toUpperCase()} · Срез: ${when(preview.data?.as_of)} · КРСК`}
              >
                <div className="campaign-stats">
                  <div>
                    <span>В сегменте</span>
                    <strong>{preview.data?.base_count ?? "—"}</strong>
                  </div>
                  <ArrowRight className="muted" size={23} />
                  <div>
                    <span>Готовы к выгрузке</span>
                    <strong className="blue-text">
                      {preview.data?.eligible_count ?? "—"}
                    </strong>
                  </div>
                  <div className="campaign-cta">
                    <Button
                      disabled={
                        mutation.isPending || !preview.data?.eligible_count
                      }
                      onClick={() => mutation.mutate()}
                    >
                      {mutation.isPending ? (
                        <LoaderCircle className="spin" size={17} />
                      ) : (
                        <ArrowDownToLine size={17} />
                      )}
                      Сформировать CSV
                    </Button>
                  </div>
                </div>
                <div className="exclusions">
                  {preview.data &&
                    Object.entries(preview.data.excluded_counts).map(
                      ([reason, count]) => (
                        <div key={reason}>
                          <span
                            className={count ? "dot dot-amber" : "dot dot-gray"}
                          />
                          <span>{reasonNames[reason]}</span>
                          <strong>{count}</strong>
                        </div>
                      ),
                    )}
                </div>
              </Panel>
              {mutation.isSuccess && (
                <Message>
                  Выгрузка сформирована. Скачайте её в истории ниже. Повторное
                  скачивание не меняет аудиторию.
                </Message>
              )}
              <Panel
                title="Предпросмотр получателей"
                subtitle="Предварительный расчёт не резервирует контакты"
              >
                {preview.isPending ? (
                  <Loading />
                ) : preview.data?.sample.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Клиент</th>
                          <th>Контакт</th>
                          <th>Предложение</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.data.sample.map((p) => (
                          <tr key={p.customer_id}>
                            <td>
                              <Link to={`/customers/${p.customer_id}`}>
                                <strong>{p.display_name}</strong>
                                <small>{p.global_customer_key}</small>
                              </Link>
                            </td>
                            <td>{p.contact}</td>
                            <td>{p.offer_title}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="inline-empty">
                    Подходящих контактов сейчас нет. Проверьте причины
                    исключения выше.
                  </div>
                )}
              </Panel>
              <Panel
                title="История выгрузок"
                subtitle="Сохраняем готовый файл и факт выгрузки"
              >
                {exports.data?.items.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Создана</th>
                          <th>Получателей</th>
                          <th>Файл</th>
                        </tr>
                      </thead>
                      <tbody>
                        {exports.data.items.map((item) => (
                          <tr key={item.id}>
                            <td>{when(item.created_at)}</td>
                            <td>{item.recipient_count}</td>
                            <td>
                              <ExportDownload id={item.id} url={item.download_url} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="inline-empty">
                    Готовые выгрузки появятся здесь.
                  </div>
                )}
              </Panel>
              <Message>
                Ограничение частоты — 7 дней по фактам выгрузки. Справочник
                отписок не подключён. Реальная отправка сообщений выполняется
                внешней системой.
              </Message>
            </>
          ) : campaigns.isPending ? (
            <Loading />
          ) : (
            <Empty
              title="Создайте первую кампанию"
              text="Выберите правило рекомендации и канал, для которого нужна аудитория."
            />
          )}
        </div>
      </div>
      {create && (
        <CampaignForm
          segments={segments.data?.items ?? []}
          rules={rules.data?.items ?? []}
          onClose={() => setCreate(false)}
          onCreated={(c) => {
            setSelected(c.id);
            setCreate(false);
            void client.invalidateQueries();
          }}
        />
      )}
    </>
  );
}
