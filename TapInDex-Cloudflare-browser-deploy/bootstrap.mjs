// Only for a fresh service whose database still needs provisioning. Not the application's API.
export default {
 fetch(){return Response.json({message:'TapInDex setup is in progress. Finish deployment before connecting the app.'},{status:503,headers:{'cache-control':'no-store'}});},
 scheduled(){}
};
