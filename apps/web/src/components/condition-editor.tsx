import { Plus, X } from "lucide-react";
import { eventNames, type Schema, type Tenant } from "../api";
import { Button } from "./ui/button";

export function ConditionEditor({
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
              { tenant_id: tenants[0]?.id ?? "", event_types: ["interaction"] },
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
            {(["interaction", ...condition.event_types.filter(type => type !== "interaction")] as const).map((type) => (
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
