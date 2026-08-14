import { Command, flagOption, valueOption } from "../command.ts";

export interface WebCommand {
	readonly command: "web";
	readonly port?: number;
	readonly open: boolean;
}

export interface WebCommandContext {
	runWeb(command: WebCommand): void | Promise<void>;
}

const portOption = valueOption("--port", (value) => {
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65_535
		? { ok: true, value: port }
		: { ok: false, error: "--port must be an integer between 1 and 65535" };
});
const noOpenOption = flagOption("--no-open");

export const webCommand = new Command<WebCommand, WebCommandContext>("web")
	.option(portOption)
	.option(noOpenOption)
	.build((input) => {
		if (input.remainingArgs.length > 0) {
			return { ok: false, errors: ["The web command does not accept positional arguments"] };
		}
		return {
			ok: true,
			command: {
				command: "web",
				port: input.value(portOption),
				open: input.value(noOpenOption) !== true,
			},
		};
	})
	.action((command, context) => context.runWeb(command));
