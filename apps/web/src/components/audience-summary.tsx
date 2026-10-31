import { eventNames, type Schema, type Tenant } from "../api";

type Definition = Schema<"SegmentDefinition">;
type NamedTenant = Pick<Tenant, "id" | "name">;

export function compatibleDestinations(definition: Definition | undefined, tenants: Tenant[]) {
  return tenants.filter(tenant => definition?.exclude_any.some(condition =>
    condition.tenant_id === tenant.id && condition.event_types.some(type => type === "interaction" || type === "purchase"),
  ));
}

export function AudienceSummary({ definition, tenants, title = "Кого приглашаем" }: { definition: Definition; tenants: NamedTenant[]; title?: string }) {
  const name = (id: string) => tenants.find(tenant => tenant.id === id)?.name ?? "Неизвестный арендатор";
  return <section className="audience-summary" aria-label="Условия аудитории">
    <strong>{title}</strong>
    <p>Окно истории: {definition.lookback_days} дней до общего среза источников.</p>
    <ul>
      {definition.include_all.map(condition => <li key={`include-${condition.tenant_id}`}>
        <strong>Есть запись:</strong> {name(condition.tenant_id)} — {condition.event_types.map(type => eventNames[type].toLowerCase()).join(" или ")}.
      </li>)}
      {definition.exclude_any.map(condition => <li key={`exclude-${condition.tenant_id}`}>
        <strong>Нет записи:</strong> {name(condition.tenant_id)} — {condition.event_types.map(type => eventNames[type].toLowerCase()).join(" или ")}.
      </li>)}
    </ul>
    <p>Нужны все условия «Есть запись» и ни одного события из «Нет записи». Клиенты с неполной историей или без корректных контактов не включаются.</p>
  </section>;
}
