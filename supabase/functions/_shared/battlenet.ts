export interface AuthUrlParams {
  clientId: string;
  redirectUri: string;
  responseType: string;
  state: string;
  scope: string;
}

export function buildAuthorizationUrl(params: AuthUrlParams): string {
  const baseUrl = "https://oauth.battle.net/authorize";
  const queryParams = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: params.responseType,
    state: params.state,
    scope: params.scope
  });

  return `${baseUrl}?${queryParams.toString()}`;
}