"""Manual salt observations; never infer measured inventory from water use."""
from copy import deepcopy
from datetime import date, timedelta
from math import isfinite


def salt_defaults():
    return {'model':'Ёлка WSC-0,5-Rx-(SC)', 'dose':1.5, 'check_days':6,
            'level':'unknown','last_checked':None,'last_added':None,
            'last_added_kg':None,'history':[]}


def number(value, maximum):
    if isinstance(value,bool): raise ValueError('Неверное число')
    try: result=float(value)
    except (ValueError,TypeError) as err: raise ValueError('Введите положительное число') from err
    if not isfinite(result) or not 0 < result <= maximum: raise ValueError('Значение вне допустимого диапазона')
    return result


def salt_action(current, action, payload, today):
    cfg=deepcopy(current)
    stamp=today.isoformat()
    if action=='settings':
        cfg['dose']=number(payload.get('dose',cfg['dose']),20)
        days=number(payload.get('check_days',cfg['check_days']),90)
        if days!=int(days): raise ValueError('Интервал должен быть целым числом дней')
        cfg['check_days']=int(days)
    elif action=='topup':
        kg=number(payload.get('kg'),100)
        cfg.update(last_added=stamp,last_added_kg=kg)
        cfg['history'].append({'action':'topup','date':stamp,'kg':kg})
        # A top-up does not establish the remaining quantity or verify the salt bed.
    elif action=='check':
        level=payload.get('level')
        if level not in ('enough','low','empty'): raise ValueError('Выберите состояние запаса соли')
        cfg.update(last_checked=stamp,level=level)
        cfg['history'].append({'action':'check','date':stamp,'level':level})
    else: raise ValueError('Неизвестное действие')
    cfg['history']=cfg['history'][-30:]
    return cfg


def salt_status(cfg,today):
    checked=cfg.get('last_checked')
    days=None if not checked else (date.fromisoformat(checked)+timedelta(days=cfg['check_days'])-today).days
    state='unknown'
    if cfg['level'] in ('low','empty'): state=cfg['level']
    elif days is not None: state='check' if days<=0 else 'ok'
    return {'state':state,'days':days,'estimated_remaining_kg':None}
