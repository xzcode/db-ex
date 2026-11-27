import type {SqlValue} from './types'

export interface SqlBrowsePredicate {text:string;parameters:SqlValue[]}
type Token={kind:'word'|'identifier'|'string'|'number'|'symbol';value:string}
const invalid=():never=>{throw Error('INVALID_FILTER: SQL 条件无效或包含不支持的语法')}
const reserved=new Set('SELECT FROM JOIN UNION INTERSECT EXCEPT WITH INSERT UPDATE DELETE DROP ALTER CREATE REPLACE TRUNCATE CALL SET USE INTO AS ORDER GROUP HAVING LIMIT OFFSET RETURNING WINDOW OVER EXISTS CASE WHEN THEN ELSE END COLLATE CAST CONVERT ESCAPE WHERE AND OR NOT IS IN LIKE BETWEEN TRUE FALSE NULL'.split(' '))
const functions:Record<string,[number,number]>={ABS:[1,1],LOWER:[1,1],UPPER:[1,1],LENGTH:[1,1],CHAR_LENGTH:[1,1],ROUND:[1,2],COALESCE:[2,50],IFNULL:[2,2],NULLIF:[2,2],TRIM:[1,1],LTRIM:[1,1],RTRIM:[1,1],SUBSTR:[2,3],SUBSTRING:[2,3],REPLACE:[3,3],INSTR:[2,2],DATE:[1,1],TIME:[1,1],HEX:[1,1]}
const quote=(s:string)=>'\x60'+s.replaceAll('\x60','\x60\x60')+'\x60'
function tokens(text:string,dialect:'mysql'|'sqlite'):Token[]{
 const out:Token[]=[]
 for(let i=0;i<text.length;){
  const c=text[i]!
  if(/\s/.test(c)){i++;continue}
  if(c==='\0'||text.startsWith('--',i)||text.startsWith('/*',i)||c==='#'||c===';')return invalid()
  if(c==="'"||c==='\x60'||dialect==='sqlite'&&(c==='"'||c==='[')){
   const end=c==='['?']':c;let value='',closed=false;i++
   while(i<text.length){
    const next=text[i++]!
    if(next==='\0')return invalid()
    if(next===end){if(end!==']'&&text[i]===end){value+=end;i++;continue}closed=true;break}
    value+=next
   }
   if(!closed||c!=="'"&&(!value||value.length>200||/[\x00-\x1f\x7f]/.test(value)))return invalid()
   out.push({kind:c==="'"?'string':'identifier',value})
  }else{
   const rest=text.slice(i)
   const number=/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest)?.[0]
   const word=/^[A-Za-z_\u0080-\uFFFF][A-Za-z_0-9$\u0080-\uFFFF]*/.exec(rest)?.[0]
   const symbol=/^(?:<=>|<>|!=|<=|>=|[=<>+*/%?,()-])/.exec(rest)?.[0]
   if(number){if(number.length>128)return invalid();out.push({kind:'number',value:number});i+=number.length}
   else if(word){if(word.length>200)return invalid();out.push({kind:'word',value:word});i+=word.length}
   else if(symbol){if(symbol==='<=>'&&dialect==='sqlite')return invalid();out.push({kind:'symbol',value:symbol});i+=symbol.length}
   else return invalid()
  }
  if(out.length>1000)return invalid()
 }
 return out
}
export function compileSqlBrowsePredicate(input:unknown,dialect:'mysql'|'sqlite'='mysql'):{sql:string;parameters:SqlValue[]}{
 if(!input||typeof input!=='object'||Array.isArray(input))return invalid()
 const {text,parameters:provided}=input as SqlBrowsePredicate
 if(typeof text!=='string'||text.length>16384||!Array.isArray(provided)||provided.length>1000||provided.some(v=>v!==null&&typeof v!=='boolean'&&!(typeof v==='string'&&v.length<=16384)&&!(typeof v==='number'&&Number.isFinite(v)&&(!Number.isInteger(v)||Number.isSafeInteger(v)))))return invalid()
 const ts=tokens(text,dialect),parameters:SqlValue[]=[]
 let at=0,bound=0,depth=0
 const word=(s:string)=>ts[at]?.kind==='word'&&ts[at]!.value.toUpperCase()===s
 const symbol=(s:string)=>ts[at]?.kind==='symbol'&&ts[at]!.value===s
 const takeWord=(s:string)=>{if(!word(s))return false;at++;return true}
 const takeSymbol=(s:string)=>{if(!symbol(s))return false;at++;return true}
 const expectWord=(s:string)=>{if(!takeWord(s))invalid()}
 const expectSymbol=(s:string)=>{if(!takeSymbol(s))invalid()}
 const nested=(fn:()=>string)=>{if(++depth>32)invalid();try{return fn()}finally{depth--}}
 function primary():string{
  if(takeSymbol('(')){const value=nested(or);expectSymbol(')');return '('+value+')'}
  const token=ts[at++];if(!token)return invalid()
  if(token.kind==='string'){parameters.push(token.value);return '?'}
  if(token.kind==='number')return token.value
  if(token.kind==='symbol'&&token.value==='?'){if(bound>=provided.length)return invalid();parameters.push(provided[bound++]!);return '?'}
  if(token.kind==='identifier')return quote(token.value)
  if(token.kind!=='word')return invalid()
  const key=token.value.toUpperCase()
  if(['NULL','TRUE','FALSE'].includes(key))return key
  if(takeSymbol('(')){
   const arity=Object.hasOwn(functions,key)?functions[key]:undefined
   if(!arity||dialect==='sqlite'&&key==='CHAR_LENGTH')return invalid()
   const args:string[]=[]
   if(!symbol(')')){do{args.push(nested(or))}while(takeSymbol(','))}
   expectSymbol(')')
   if(args.length<arity[0]||args.length>arity[1])return invalid()
   return key+'('+args.join(', ')+')'
  }
  if(reserved.has(key))return invalid()
  return quote(token.value)
 }
 function unary():string{
  if(takeSymbol('+'))return '(+'+nested(unary)+')'
  if(takeSymbol('-'))return '(-'+nested(unary)+')'
  return primary()
 }
 function product():string{
  let left=unary()
  while(['*','/','%'].some(symbol)){const op=ts[at++]!.value;left='('+left+' '+op+' '+unary()+')'}
  return left
 }
 function sum():string{
  let left=product()
  while(symbol('+')||symbol('-')){const op=ts[at++]!.value;left='('+left+' '+op+' '+product()+')'}
  return left
 }
 function compare():string{
  const left=sum()
  if(takeWord('IS')){
   const not=takeWord('NOT')
   const target=['NULL','TRUE','FALSE'].find(word)
   if(!target)return invalid()
   at++;return '('+left+' IS '+(not?'NOT ':'')+target+')'
  }
  if(ts[at]?.kind==='symbol'&&['=','!=','<>','<','>','<=','>=','<=>'].includes(ts[at]!.value)){
   const op=ts[at++]!.value;return '('+left+' '+op+' '+sum()+')'
  }
  const neg=takeWord('NOT'),prefix=neg?'NOT ':''
  if(takeWord('IN')){
   expectSymbol('(');const values:string[]=[]
   do{values.push(nested(sum));if(values.length>500)invalid()}while(takeSymbol(','))
   expectSymbol(')');return '('+left+' '+prefix+'IN ('+values.join(', ')+'))'
  }
  if(takeWord('BETWEEN')){const low=sum();expectWord('AND');return '('+left+' '+prefix+'BETWEEN '+low+' AND '+sum()+')'}
  if(takeWord('LIKE')){const right=sum(),escape=takeWord('ESCAPE')?' ESCAPE '+sum():'';return '('+left+' '+prefix+'LIKE '+right+escape+')'}
  if(neg)return invalid()
  return left
 }
 function not():string{return takeWord('NOT')?'(NOT '+nested(not)+')':compare()}
 function and():string{let left=not();while(takeWord('AND'))left='('+left+' AND '+not()+')';return left}
 function or():string{let left=and();while(takeWord('OR'))left='('+left+' OR '+and()+')';return left}
 const sql=ts.length?or():''
 if(at!==ts.length||bound!==provided.length||parameters.length>1000)return invalid()
 return {sql,parameters}
}
