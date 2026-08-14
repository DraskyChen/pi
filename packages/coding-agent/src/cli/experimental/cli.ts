import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type PiCommandContext, piCommand } from "./commands/pi.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";
import { type WebCommandContext, webCommand } from "./commands/web.ts";

export type ExperimentalCliContext = PiCommandContext & ServerCommandContext & ClientCommandContext & WebCommandContext;

export const experimentalCli = piCommand.command(serverCommand).command(clientCommand).command(webCommand);
