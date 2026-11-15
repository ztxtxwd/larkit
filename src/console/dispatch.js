import {
  appliedScopes,
  createApp,
  enableBotWs,
  getApp,
  getCredentials,
  grantScopes,
  listApps,
  listScopes,
  listVersions,
  publishVersion,
  updateAppInfo,
} from "./client.js";
import { browserFallback } from "./browser.js";

export async function consoleDispatch(args = {}) {
  const action = args.action;
  const profile = args.profile;
  switch (action) {
    case "list_apps":
      return listApps({
        profile,
        limit: args.limit,
        query: args.query,
      });
    case "create_app":
      return createApp({
        name: args.name,
        desc: args.desc,
        avatar: args.avatar,
        appSceneType: args.app_scene_type,
        primaryLang: args.primary_lang,
        profile,
        dryRun: args.dry_run,
      });
    case "get_app":
      return getApp({ appId: args.app_id, profile });
    case "get_credentials":
      return getCredentials({ appId: args.app_id, profile });
    case "update_app_info":
      return updateAppInfo({
        appId: args.app_id,
        name: args.name,
        desc: args.desc,
        avatar: args.avatar,
        i18n: args.i18n,
        languages: args.languages,
        profile,
        dryRun: args.dry_run,
      });
    case "list_scopes":
      return listScopes({ appId: args.app_id, profile });
    case "applied_scopes":
      return appliedScopes({ appId: args.app_id, profile });
    case "grant_scopes":
      return grantScopes({
        appId: args.app_id,
        scopes: args.scopes,
        scopeType: args.scope_type,
        operation: args.operation,
        profile,
        dryRun: args.dry_run,
      });
    case "list_versions":
      return listVersions({ appId: args.app_id, profile });
    case "enable_bot_ws":
      return enableBotWs({
        appId: args.app_id,
        enableBot: args.enable_bot,
        enableEvents: args.enable_events,
        enableCallbacks: args.enable_callbacks,
        enableCardRequestMode: args.enable_card_request_mode,
        profile,
        dryRun: args.dry_run,
      });
    case "publish":
      return publishVersion({
        appId: args.app_id,
        version: args.version,
        remark: args.remark,
        fullRelease: args.full_release,
        createIfMissing: args.create_if_missing,
        release: args.release,
        profile,
        dryRun: args.dry_run,
      });
    case "browser_fallback":
      return browserFallback({
        profile,
        url: args.url,
        waitMs: args.wait_ms,
        actions: args.actions,
        screenshot: args.screenshot,
        recordAs: args.record_as,
      });
    default:
      throw new Error(
        `unknown console action: ${action}; expected list_apps|create_app|get_app|get_credentials|update_app_info|list_scopes|applied_scopes|grant_scopes|list_versions|enable_bot_ws|publish|browser_fallback`,
      );
  }
}
