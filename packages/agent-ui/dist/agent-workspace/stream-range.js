export async function readCommittedRange(session, startIndex, endIndex, signal) {
    if (endIndex <= startIndex)
        return [];
    const events = [];
    let completeLength = 0;
    for await (const event of session.stream({
        follow: false, signal, startIndex, streamReconnectPolicy: { reconnect: false },
    })) {
        if (event.meta.position.line >= endIndex)
            break;
        events.push(event);
        if (event.meta.endOfLine !== false) {
            completeLength = events.length;
            if ((event.meta.next ?? event.meta.position.line + 1) >= endIndex)
                break;
        }
    }
    return events.slice(0, completeLength);
}
//# sourceMappingURL=stream-range.js.map