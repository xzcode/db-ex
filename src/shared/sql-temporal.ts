/** Validate SQL temporal strings without routing through JS Date/timezone.
 * Preserve the exact fractional second digits, including trailing zeroes. */
export type SqlTemporalKind='date'|'datetime'|'time'
export function sqlTemporalKind(type:string):SqlTemporalKind|undefined{
 if(/^DATE\b/i.test(type))return 'date'
 if(/^(?:DATETIME|TIMESTAMP)\b/i.test(type))return 'datetime'
 if(/^TIME\b/i.test(type))return 'time'
}
function dateValid(v:string){
 const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(v);if(!m)return false
 const y=Number(m[1]),month=Number(m[2]),d=Number(m[3]),leap=y%4===0&&(y%100!==0||y%400===0)
 return y>=1&&month>=1&&month<=12&&d>=1&&d<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1]!
}
function timeValid(v:string,duration:boolean,precision:number){
 const m=/^(-?)(\d{1,3}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(v);if(!m)return false
 if(!duration&&(m[1]||m[2]!.length!==2))return false
 return Number(m[2])<=(duration?838:23)&&Number(m[3])<=59&&Number(m[4])<=59&&(m[5]?.length||0)<=precision
}
export function sqlTemporalParts(type:string,value:string):{date:string;time:string}|undefined{
 const kind=sqlTemporalKind(type);if(!kind)return
 const precisionMatch=/\((\d)\)/.exec(type),precision=precisionMatch?Math.min(6,Number(precisionMatch[1])):6
 if(kind==='date')return dateValid(value)?{date:value,time:''}:undefined
 if(kind==='time')return timeValid(value,true,precision)?{date:'',time:value}:undefined
 const m=/^(\d{4}-\d{2}-\d{2}) (.+)$/.exec(value)
 return m&&dateValid(m[1]!)&&timeValid(m[2]!,false,precision)?{date:m[1]!,time:m[2]!}:undefined
}
export function validateSqlTemporal(type:string,value:string):string{
 if(sqlTemporalKind(type)&&!sqlTemporalParts(type,value))throw Error('INVALID_TEMPORAL: 日期或时间格式无效')
 return value
}
