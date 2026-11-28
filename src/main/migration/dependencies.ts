import type {MigrationStep} from '../../shared/migration'
export function orderMigrationSteps(input:MigrationStep[]):MigrationStep[]{
 const byId=new Map(input.map(step=>[step.id,step])),done=new Set<string>(),visiting=new Set<string>(),ordered:MigrationStep[]=[]
 function review(step:MigrationStep){return {...step,action:'review' as const,sql:[],executable:false,transfer:false,dependsOn:undefined,changes:[...step.changes,'DEPENDENCY REQUIRES MANUAL REVIEW']}}
 function visit(id:string):boolean{
  if(done.has(id))return byId.get(id)?.executable===true
  let step=byId.get(id)
  if(!step||!step.executable||visiting.has(id))return false
  visiting.add(id)
  for(const dep of step.dependsOn||[])if(!visit(dep)){step=review(step);byId.set(id,step);break}
  visiting.delete(id);done.add(id);ordered.push(step)
  return step.executable
 }
 for(const step of input)if(step.executable)visit(step.id)
 for(const step of input)if(!done.has(step.id))ordered.push(byId.get(step.id)!)
 return ordered
}
