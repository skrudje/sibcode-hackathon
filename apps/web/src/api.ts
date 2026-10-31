import { useQuery } from "@tanstack/react-query";
import type { components } from "./api.generated";

export type Schema<K extends keyof components["schemas"]> =
  components["schemas"][K];
export type Customer = Schema<"Customer">;
export type Source = Schema<"Source">;
export type Tenant = Schema<"Tenant">;
export type Segment = Schema<"Segment">;
export type Rule = Schema<"RecommendationRule">;
export type Campaign = Schema<"Campaign">;
export type ImportJob = Schema<"ImportJob">;

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (typeof options.body === "string")
    headers.set("Content-Type", "application/json");
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  if (!response.ok) {
    const payload = (await response
      .json()
      .catch(() => null)) as Schema<"ApiError"> | null;
    if (response.status === 401 && !path.startsWith("/auth"))
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      payload?.error.message ?? "Не удалось связаться с сервером",
      response.status,
      payload?.error.code ?? "network_error",
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const useData = <T>(
  key: readonly unknown[],
  path: string,
  enabled = true,
) => useQuery({ queryKey: key, queryFn: () => api<T>(path), enabled });
export const when = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat("ru-RU", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Krasnoyarsk",
      }).format(new Date(value))
    : "Пока нет данных";
export const number = (value: number) =>
  new Intl.NumberFormat("ru-RU").format(value);
export const eventNames = {
  visit: "Визит",
  purchase: "Покупка",
  booking: "Бронирование",
};
export const sourceNames = {
  crm_csv: "CRM · CSV",
  pos_xlsx: "POS · Excel",
  rest_api: "REST API · JSON",
};
export const reasonNames: Record<string, string> = {
  identity_unverified: "Нет подтверждённого общего ключа клиента",
  insufficient_history: "Недостаточно истории для уверенного вывода",
  no_matching_rules: "Сейчас нет подходящих правил",
  no_active_offers: "Нет действующих предложений",
  offer_inactive: "Предложение неактивно",
  missing_contact: "Нет контакта",
  contact_conflict: "Конфликт контактов",
  duplicate_contact: "Повтор контакта",
  already_exported: "Уже выгружен",
  cooldown: "Ограничение частоты",
};

export async function uploadFile(source: Source, file: Blob, filename: string) {
  const form = new FormData();
  form.append("file", file, filename);
  return api<ImportJob>(`/sources/${source.id}/imports`, {
    method: "POST",
    body: form,
  });
}

export async function exampleImport(source: Source, followup = false) {
  if (source.kind === "rest_api")
    return api<ImportJob>(`/sources/${source.id}/sync`, { method: "POST" });
  const name =
    source.kind === "pos_xlsx"
      ? "pos_B.xlsx"
      : followup
        ? "crm_C_after.csv"
        : "crm_C_initial.csv";
  const response = await fetch(`/api/v1/demo/files/${name}`, {
    credentials: "same-origin",
  });
  if (!response.ok)
    throw new Error("Не удалось получить демонстрационный файл");
  return uploadFile(source, await response.blob(), name);
}

export async function waitImport(id: string) {
  for (let i = 0; i < 180; i++) {
    const job = await api<ImportJob>(`/imports/${id}`);
    if (!["queued", "running"].includes(job.status)) {
      if (job.status === "failed")
        throw new Error(job.failure_message ?? "Импорт завершился ошибкой");
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    "Обработка продолжается дольше ожидаемого. Проверьте состояние задания.",
  );
}
