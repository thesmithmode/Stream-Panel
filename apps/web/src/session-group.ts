const day=86400000;
/** Compare calendar days in Moscow, including Monday-based week boundaries. */
export function sessionGroup(at:number,now=Date.now()):string{
 const today=Math.floor((now+3*3600000)/day),date=Math.floor((at+3*3600000)/day);
 if(date>=today)return 'Сегодня';if(date===today-1)return 'Вчера';
 const monday=today-((today+3)%7);
 if(date>=monday)return 'На этой неделе';if(date>=monday-7)return 'На прошлой неделе';
 if(today-date<30)return 'Ранее в этом месяце';
 return new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',month:'long',year:'numeric'}).format(at);
}
