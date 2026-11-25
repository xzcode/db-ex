/** Help covers only the index keys and options accepted by mongo.createIndex. */
export const mongoIndexDirections = [
 {value:'1',description:'升序'},
 {value:'-1',description:'降序'},
 {value:'"text"',description:'文本索引'},
 {value:'"hashed"',description:'哈希索引'},
 {value:'"2d"',description:'二维地理索引'},
 {value:'"2dsphere"',description:'球面地理索引'}
] as const
export const mongoIndexOptionHelp = [
 {name:'name',type:'string',description:'自定义索引名称；省略时自动生成。'},
 {name:'unique',type:'boolean',description:'禁止重复索引键；已有重复值可能导致创建失败。'},
 {name:'sparse',type:'boolean',description:'稀疏索引：仅索引存在索引字段的文档（单字段）。'},
 {name:'hidden',type:'boolean',description:'对查询优化器隐藏索引，但仍维护索引。'},
 {name:'expireAfterSeconds',type:'integer',description:'TTL 秒数（0–2147483647）；使用单个日期字段，过期删除可能延迟。'},
 {name:'partialFilterExpression',type:'object',description:'仅索引符合条件的文档；不能与 sparse 同时使用。'}
] as const
export const mongoIndexExamples = [
 {id:'ascending',label:'升序',keys:{createdAt:1},options:{name:'createdAt_1'}},
 {id:'descending',label:'降序',keys:{createdAt:-1},options:{name:'createdAt_-1'}},
 {id:'compound',label:'复合索引',keys:{userId:1,createdAt:-1},options:{name:'userId_1_createdAt_-1'}},
 {id:'unique',label:'唯一索引',keys:{email:1},options:{name:'email_unique',unique:true}},
 {id:'sparse',label:'稀疏索引',keys:{phone:1},options:{name:'phone_sparse',sparse:true}},
 {id:'ttl',label:'TTL 索引',keys:{expiresAt:1},options:{name:'expiresAt_ttl',expireAfterSeconds:0}},
 {id:'partial',label:'部分索引',keys:{email:1},options:{name:'active_email',partialFilterExpression:{active:true}}},
 {id:'hidden',label:'隐藏索引',keys:{createdAt:-1},options:{name:'createdAt_hidden',hidden:true}},
 {id:'text',label:'文本索引',keys:{title:'text',description:'text'},options:{name:'title_description_text'}},
 {id:'hashed',label:'哈希索引',keys:{userId:'hashed'},options:{name:'userId_hashed'}},
 {id:'2d',label:'二维地理索引',keys:{coordinates:'2d'},options:{name:'coordinates_2d'}},
 {id:'2dsphere',label:'球面地理索引',keys:{location:'2dsphere'},options:{name:'location_2dsphere'}}
] as const
export function mongoIndexExampleText(id:string):{keys:string;options:string}|undefined{
 const example=mongoIndexExamples.find(item=>item.id===id)
 return example?{keys:JSON.stringify(example.keys,null,2),options:JSON.stringify(example.options,null,2)}:undefined
}
