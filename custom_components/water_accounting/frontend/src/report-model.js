/* Pure, read-only report arithmetic. Volumes are m³; dates are Europe/Moscow. */
const WaterReportModel = (() => {
  const HOUR = 3600000;
  const DAY = 24 * HOUR;
  const ZONE = 'Europe/Moscow';
  const HOLIDAYS = new Set(['01-01','01-02','01-03','01-04','01-05','01-06','01-07','01-08',
    '02-23','03-08','05-01','05-09','06-12','11-04']);
  // National five-day production calendars. Sources and scope: docs/WATER_STATISTICS.md.
  // Transfers and statutory replacement rest days are weekends, not extra national holidays.
  const CALENDARS = {
    2025: {rest: new Set(['05-02','05-08','06-13','11-03','12-31']), work: new Set(['11-01'])},
    2026: {rest: new Set(['01-09','03-09','05-11','12-31']), work: new Set()},
  };
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  });

  function finite(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const stamp = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10) === value;
  }

  function localDate(value) {
    const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(value)).map(p=>[p.type,p.value]));
    return parts.year + '-' + parts.month + '-' + parts.day;
  }

  function midnight(key) {
    // Settings accept modern dates (2015 onward), when Moscow has UTC+03 all year.
    return Date.parse(key + 'T00:00:00+03:00');
  }

  function addDays(key, count) {
    return new Date(Date.parse(key+'T12:00:00Z') + count*DAY).toISOString().slice(0,10);
  }

  function priorMonth(key) {
    const d = new Date(key.slice(0,7)+'-01T12:00:00Z');
    d.setUTCMonth(d.getUTCMonth()-1);
    return d.toISOString().slice(0,10);
  }

  function classifyDate(key) {
    if (!validDate(key)) return {kind:'unknown',known:false};
    const year = Number(key.slice(0,4));
    const short = key.slice(5);
    const calendar = CALENDARS[year];
    if (HOLIDAYS.has(short)) return {kind:'holiday',known:!!calendar};
    if (!calendar) return {kind:'unknown',known:false};
    if (calendar.work.has(short)) return {kind:'workday',known:true};
    const weekday = new Date(key+'T12:00:00Z').getUTCDay();
    return {kind:calendar.rest.has(short) || weekday === 0 || weekday === 6 ? 'weekend':'workday',known:true};
  }

  function periods(now, settings = {}) {
    const stamp = finite(now);
    if (stamp === null) throw new Error('Неизвестна дата расчёта');
    const today = localDate(stamp);
    const start = settings.statistics_start_date || '2026-10-27';
    if (!validDate(start) || start < '2015-01-01') throw new Error('Неверная дата начала статистики');
    const currentMonthStart = today.slice(0,7)+'-01';
    const previousMonthStart = priorMonth(today);
    const requestDate = start < previousMonthStart ? start : previousMonthStart;
    const requestStart = midnight(requestDate);
    const requestEnd = midnight(today);
    // Fail explicitly instead of silently truncating a cumulative report or freezing the panel.
    if ((requestEnd-requestStart)/DAY > 3660) throw new Error('Период больше 10 лет. Уточните дату начала статистики.');
    const weekday = new Date(today+'T12:00:00Z').getUTCDay();
    let previousReportEnd = addDays(today,-((weekday+6)%7));
    if (previousReportEnd === today) previousReportEnd = addDays(today,-7);
    return {today,start,end:addDays(today,-1),typicalStart:start,currentMonthStart,previousMonthStart,
      requestStart,requestEnd,previousReportEnd};
  }

  function hourGrid(rows, period, unit) {
    const factor = ['m³','m3','м³','м3'].includes(unit) ? 1 : ['L','l','л'].includes(unit) ? 0.001 : null;
    const indexed = new Map();
    if (factor !== null && Array.isArray(rows)) rows.forEach(raw => {
      if (!raw || typeof raw !== 'object') return;
      const start = finite(raw.start);
      if (start === null || start % HOUR !== 0 || start < period.requestStart-HOUR || start >= period.requestEnd) return;
      const change = finite(raw.change);
      const sum = finite(raw.sum);
      const item = {change:change !== null && change >= 0 ? change*factor : null,
        sum:sum !== null ? sum*factor : null};
      indexed.set(start,indexed.has(start) ? {change:null,sum:null} : item);
    });
    const days = [];
    for(let start=period.requestStart;start<period.requestEnd;start+=DAY) {
      let hours=0;
      let known=0;
      for(let hour=start;hour<start+DAY;hour+=HOUR) {
        const row=indexed.get(hour), before=indexed.get(hour-HOUR);
        if (!row || !before || row.change === null || row.sum === null || before.sum === null) continue;
        // Change must describe this exact adjacent interval, never a bridge across missing data.
        if (Math.abs((row.sum-before.sum)-row.change)>Math.max(1e-7,Math.abs(row.change)*1e-6)) continue;
        hours++;
        known+=row.change;
      }
      const date=localDate(start);
      const calendar=classifyDate(date);
      days.push({date,kind:calendar.kind,calendar_known:calendar.known,hours,expected_hours:24,
        gross_m3:hours===24 ? known : null,known_gross_m3:hours ? known : null});
    }
    return {days,unitValid:factor!==null};
  }

  function journal(treatment, available, period) {
    const history=treatment && treatment.settings && treatment.settings.salt && treatment.settings.salt.history;
    const ready=available===true && Array.isArray(history);
    const byDate=new Map(), identities=new Map(), conflictDates=new Set(), issues=[];
    let malformed=false;
    if (ready) history.forEach(event=> {
      if (!event || typeof event !== 'object' || event.action!=='regeneration') return;
      const date=event.date;
      if (!validDate(date)) { malformed=true;issues.push('В журнале есть цикл с неверной датой.');return; }
      const at=midnight(date);
      const value=finite(event.water_m3);
      const measured=value!==null && value>=0 && value<=10 && event.completed!==false
        && event.water_basis!=='estimated' && event.water_basis!=='assumed' && event.estimated!==true;
      const id=typeof event.id==='string' && event.id ? event.id
        : typeof event.operation_id==='string' && event.operation_id ? event.operation_id : null;
      const record={date,volume_m3:measured ? value:null,status:measured?'measured':'missing_volume',
        source:'Водоподготовка · журнал измеренных циклов'};
      if (id && identities.has(id)) {
        const old=identities.get(id);
        if (old.date===date && old.volume_m3===record.volume_m3 && old.status===record.status) return;
        conflictDates.add(old.date);conflictDates.add(date);
      } else if (id) identities.set(id,record);
      // An ID conflict beyond the displayed window can still make an in-window
      // cycle ambiguous. Validate identities against the whole journal first.
      if (at<period.requestStart || at>=period.requestEnd) return;
      if(!byDate.has(date))byDate.set(date,[]);
      byDate.get(date).push(record);
    });
    const records=[];
    byDate.forEach((items,date)=> {
      if(items.length>1 || conflictDates.has(date)) {
        byDate.set(date,{date,volume_m3:null,status:'ambiguous',source:'Водоподготовка · неоднозначные записи'});
        issues.push('Несколько неоднозначных записей регенерации за '+date+'.');
      } else {
        byDate.set(date,items[0]);
        if(items[0].volume_m3===null)issues.push('Не указан измеренный объём регенерации за '+date+'.');
      }
      records.push(byDate.get(date));
    });
    records.sort((a,b)=>a.date.localeCompare(b.date));
    return {available:ready,byDate,records,issues,malformed};
  }

  function applyRegenerations(days, source, settings) {
    const from=settings.regeneration_verified_from, through=settings.regeneration_verified_through;
    const verifiedRange=validDate(from) && validDate(through) && from<=through;
    return days.map(day=> {
      const event=source.byDate.get(day.date);
      const volume=source.available && !source.malformed ? (event ? event.volume_m3 : 0) : null;
      let adjusted=day.gross_m3!==null && volume!==null ? day.gross_m3-volume:null;
      let problem=day.gross_m3===null ? 'missing_data' : volume===null ? 'regeneration_unknown' : null;
      if(adjusted!==null && adjusted < -1e-7) { adjusted=null;problem='regeneration_exceeds_total'; }
      // Remove only roundoff at exact zero, not a contradictory measurement.
      if(adjusted!==null && Math.abs(adjusted)<1e-10)adjusted=0;
      const verified=adjusted!==null && verifiedRange && from<=day.date && through>=day.date;
      return {...day,regeneration_m3:volume,regeneration_count:event && volume!==null ? 1:0,
        adjusted_m3:adjusted,net_m3:verified ? adjusted:null,net_verified:verified,problem};
    });
  }

  function group(rows) {
    if(!rows.length)return {days:0,gross_m3:null,adjusted_m3:null,net_m3:null,gross_lpd:null,
      adjusted_lpd:null,net_lpd:null,regeneration_m3:null};
    const gross=rows.reduce((s,d)=>s+d.gross_m3,0);
    const adjusted=rows.reduce((s,d)=>s+d.adjusted_m3,0);
    const complete=rows.every(d=>d.net_verified);
    return {days:rows.length,gross_m3:gross,adjusted_m3:adjusted,net_m3:complete?adjusted:null,
      gross_lpd:gross*1000/rows.length,adjusted_lpd:adjusted*1000/rows.length,
      net_lpd:complete?adjusted*1000/rows.length:null,
      regeneration_m3:rows.reduce((s,d)=>s+d.regeneration_m3,0)};
  }

  function typical(days, start, endExclusive, threshold) {
    const population=days.filter(d=>d.date>=start&&d.date<endExclusive);
    const included=[],excluded=[];
    population.forEach(day=> {
      const reason=day.problem || (day.adjusted_m3===0 || day.adjusted_m3*1000 < threshold-1e-7 ? 'low_consumption':null);
      if(reason)excluded.push({date:day.date,reason});
      else included.push(day);
    });
    const kinds={all:included,workday:included.filter(d=>d.kind==='workday'&&d.calendar_known),
      weekend:included.filter(d=>d.kind==='weekend'&&d.calendar_known),
      holiday:included.filter(d=>d.kind==='holiday'&&d.calendar_known),
      nonworking:included.filter(d=>['weekend','holiday'].includes(d.kind)&&d.calendar_known)};
    const groups=Object.fromEntries(Object.entries(kinds).map(([key,rows])=>[key,group(rows)]));
    return {start,end:addDays(endExclusive,-1),calendar_days:population.length,included_days:included.length,
      excluded_days:excluded.length,excluded,groups,calendar_unknown_days:included.filter(d=>!d.calendar_known).length,
      threshold_l:threshold,net_verified:included.length>0&&included.every(d=>d.net_verified)};
  }

  function month(days,key,start,endExclusive,source) {
    const rows=days.filter(d=>d.date>=start&&d.date<endExclusive);
    const expected=Math.max(0,Math.round((midnight(endExclusive)-midnight(start))/DAY));
    const complete=expected>0 && rows.length===expected && rows.every(d=>d.gross_m3!==null);
    const adjustedComplete=complete && rows.every(d=>d.adjusted_m3!==null);
    const netComplete=adjustedComplete && rows.every(d=>d.net_verified);
    const known=rows.filter(d=>d.known_gross_m3!==null);
    const knownGross=known.length?known.reduce((s,d)=>s+d.known_gross_m3,0):null;
    const gross=complete?rows.reduce((s,d)=>s+d.gross_m3,0):null;
    const adjusted=adjustedComplete?rows.reduce((s,d)=>s+d.adjusted_m3,0):null;
    const measured=source.records.filter(e=>e.date>=start&&e.date<endExclusive&&e.volume_m3!==null);
    return {key,start,end:addDays(endExclusive,-1),expected_days:expected,
      complete_days:rows.filter(d=>d.gross_m3!==null).length,missing_dates:rows.filter(d=>d.gross_m3===null).map(d=>d.date),
      status:complete?'complete':known.length?'partial':'empty',gross_m3:gross,known_gross_m3:knownGross,
      adjusted_m3:adjusted,net_m3:netComplete?adjusted:null,gross_lpd:gross===null?null:gross*1000/expected,
      adjusted_lpd:adjusted===null?null:adjusted*1000/expected,net_lpd:netComplete?adjusted*1000/expected:null,
      regeneration_m3:source.available?measured.reduce((s,e)=>s+e.volume_m3,0):null,cycles:measured.length,
      unknown_cycles:source.records.filter(e=>e.date>=start&&e.date<endExclusive&&e.volume_m3===null).length};
  }

  function build({now,settings={},rows,treatment,treatmentAvailable=false,unit}) {
    const period=periods(now,settings);
    const value=finite(settings.low_day_threshold_l);
    const threshold=value!==null && value>=0 && value<=10000?value:100;
    const grid=hourGrid(rows,period,unit);
    const source=journal(treatment,treatmentAvailable,period);
    const days=applyRegenerations(grid.days,source,settings);
    const current=typical(days,period.start,period.today,threshold);
    const months=[month(days,'current',period.currentMonthStart,period.today,source),
      month(days,'previous',period.previousMonthStart,period.currentMonthStart,source)];
    const warnings=[];
    if(!grid.unitValid)warnings.push('Единица статистики счётчика не подтверждена. Расход не рассчитан.');
    if(!source.available)warnings.push('Журнал «Водоподготовки» недоступен. Объёмы регенераций неизвестны.');
    else if(!current.net_verified)warnings.push('Полнота журнала регенераций не подтверждена для всей выборки. Остаток после учтённых циклов не равен подтверждённому чистому расходу.');
    if(source.malformed)warnings.push('В журнале есть цикл с неверной датой; вычитание требует уточнения.');
    if(current.calendar_unknown_days)warnings.push('Для части дат не проверены переносы выходных РФ. Эти даты есть в общем среднем, но не в календарных группах.');
    if(current.excluded.some(d=>d.reason==='regeneration_exceeds_total'))warnings.push('Объём регенерации превышает суточный расход; отрицательный остаток не используется.');
    if(period.start>=period.today)warnings.push('После выбранной даты начала пока нет завершённых суток.');
    const previous=period.previousReportEnd>period.start ? typical(days,period.start,period.previousReportEnd,threshold):null;
    const delta=(key)=>previous && current.groups.all[key]!==null && previous.groups.all[key]!==null
      ?current.groups.all[key]-previous.groups.all[key]:null;
    const previousAvailable=!!previous&&previous.included_days>0&&current.included_days>0;
    const events=source.records.filter(e=>e.date>=period.start&&e.date<period.today);
    const measured=events.filter(e=>e.volume_m3!==null);
    return {timezone:ZONE,generated_at:new Date(now).toISOString(),periods:period,typical:current,months,
      regenerations:{events,volume_m3:source.available?measured.reduce((s,e)=>s+e.volume_m3,0):null,
        cycles:measured.length,issues:source.issues,available:source.available,revision:treatment?.revision??null},
      comparison:{available:previousAvailable,as_of:period.previousReportEnd,kind:'reconstructed',
        previous:previousAvailable?previous:null,delta_all:{gross_lpd:delta('gross_lpd'),adjusted_lpd:delta('adjusted_lpd'),net_lpd:delta('net_lpd')}},
      warnings};
  }

  return Object.freeze({periods,build,classifyDate});
})();
