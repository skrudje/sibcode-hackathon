import re


def normalize_contact(channel, value):
    if not value:
        return None
    value = value.strip()
    if channel == 'email':
        return value.lower() if len(value) <= 320 and re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', value) else None
    if channel == 'sms':
        value = re.sub(r'[\s().\-–—]', '', value)
        if value.startswith('00'):
            value = '+' + value[2:]
        if re.fullmatch(r'\d{10}', value):
            value = '+7' + value
        elif re.fullmatch(r'[78]\d{10}', value):
            value = '+7' + value[1:]
        return value if re.fullmatch(r'\+[1-9]\d{7,14}', value) else None
    return value or None
