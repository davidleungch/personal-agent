import { google } from "googleapis";
import { z } from "zod";

const credentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1)
});

export function createGoogleOAuthClient(
  credentials: z.input<typeof credentialsSchema>
): InstanceType<typeof google.auth.OAuth2> {
  const value = credentialsSchema.parse(credentials);
  const client = new google.auth.OAuth2(value.clientId, value.clientSecret);
  client.setCredentials({ refresh_token: value.refreshToken });
  return client;
}
