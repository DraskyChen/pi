export interface ScrollMetrics {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
}

export function shouldFollowOutput({ scrollHeight, scrollTop, clientHeight }: ScrollMetrics): boolean {
	return scrollHeight - scrollTop - clientHeight <= 64;
}
