import type { FilterType, FilterValueTypeMode } from './browse-filter'
/** The friendly categories are presentation metadata, not BSON types. */
export const mongoValueCategories = [
  { value:'text', label:'文本', type:'String' },
  { value:'number', label:'数字', type:'Number' },
  { value:'datetime', label:'日期时间', type:'ISODate' },
  { value:'objectId', label:'对象 ID', type:'ObjectId' },
  { value:'custom', label:'自定义', type:'Custom' },
] as const
export type MongoValueCategory = typeof mongoValueCategories[number]['value']
export function valueCategory(type:FilterType):MongoValueCategory {
  if (type==='String') return 'text'
  if (['Int32','Long','Double','Decimal128','Number'].includes(type)) return 'number'
  if (type==='ISODate') return 'datetime'
  if (type==='ObjectId') return 'objectId'
  return 'custom'
}
export function categoryType(value:unknown):FilterType {
  return mongoValueCategories.find(item=>item.value===value)?.type || 'String'
}
export function categoryLabel(type:FilterType):string {
  return mongoValueCategories.find(item=>item.value===valueCategory(type))!.label
}
/** New manual text uses the category's parser, not a stale suggested subtype. */
export function manualValueType(type:FilterType):FilterType { return categoryType(valueCategory(type)) }

/** A BSON ObjectId's textual representation is exactly 24 ASCII hex digits.
 * This validates its syntax only; no database read or existence check occurs.
 */
export function isObjectIdText(value: string): boolean {
  return value.length === 24 && /^[0-9a-f]{24}$/i.test(value)
}
/** Only infer an ObjectId in automatic text mode. Explicit choices and typed
 * suggestions are respected, even when a stored String looks like an ID.
 */
export function detectMongoInputType(
  type: FilterType, value: string, mode?: FilterValueTypeMode,
): { type: FilterType; valueTypeMode?: FilterValueTypeMode } {
  if (mode === 'manual' || mode === 'suggested') {
    return { type: manualValueType(type), valueTypeMode: mode }
  }
  if (mode === 'auto-object-id') {
    return isObjectIdText(value)
      ? { type: 'ObjectId', valueTypeMode: 'auto-object-id' }
      : { type: 'String', valueTypeMode: undefined }
  }
  if (type === 'String' && isObjectIdText(value)) return { type: 'ObjectId', valueTypeMode: 'auto-object-id' }
  return { type: manualValueType(type), valueTypeMode: undefined }
}
