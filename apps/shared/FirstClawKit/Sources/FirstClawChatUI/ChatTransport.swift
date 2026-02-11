import Foundation

public enum FirstClawChatTransportEvent: Sendable {
    case health(ok: Bool)
    case tick
    case chat(FirstClawChatEventPayload)
    case agent(FirstClawAgentEventPayload)
    case seqGap
}

public protocol FirstClawChatTransport: Sendable {
    func requestHistory(sessionKey: String) async throws -> FirstClawChatHistoryPayload
    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [FirstClawChatAttachmentPayload]) async throws -> FirstClawChatSendResponse

    func abortRun(sessionKey: String, runId: String) async throws
    func listSessions(limit: Int?) async throws -> FirstClawChatSessionsListResponse

    func requestHealth(timeoutMs: Int) async throws -> Bool
    func events() -> AsyncStream<FirstClawChatTransportEvent>

    func setActiveSessionKey(_ sessionKey: String) async throws
}

extension FirstClawChatTransport {
    public func setActiveSessionKey(_: String) async throws {}

    public func abortRun(sessionKey _: String, runId _: String) async throws {
        throw NSError(
            domain: "FirstClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "chat.abort not supported by this transport"])
    }

    public func listSessions(limit _: Int?) async throws -> FirstClawChatSessionsListResponse {
        throw NSError(
            domain: "FirstClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.list not supported by this transport"])
    }
}
