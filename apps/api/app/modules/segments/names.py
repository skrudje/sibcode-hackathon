"""Short audience names describe the source group and the excluded records."""


def audience_name(origins: list[str], destination: str, lookback_days: int) -> str:
    def compact(value):
        return value if len(value) <= 38 else value[:37] + '…'

    return (f'Аудитория: {compact(" + ".join(origins))} → '
            f'без записей в {compact(destination)} · {lookback_days} дн.')
