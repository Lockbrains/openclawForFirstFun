import Foundation

public enum FirstClawRemindersCommand: String, Codable, Sendable {
    case list = "reminders.list"
    case add = "reminders.add"
}

public enum FirstClawReminderStatusFilter: String, Codable, Sendable {
    case incomplete
    case completed
    case all
}

public struct FirstClawRemindersListParams: Codable, Sendable, Equatable {
    public var status: FirstClawReminderStatusFilter?
    public var limit: Int?

    public init(status: FirstClawReminderStatusFilter? = nil, limit: Int? = nil) {
        self.status = status
        self.limit = limit
    }
}

public struct FirstClawRemindersAddParams: Codable, Sendable, Equatable {
    public var title: String
    public var dueISO: String?
    public var notes: String?
    public var listId: String?
    public var listName: String?

    public init(
        title: String,
        dueISO: String? = nil,
        notes: String? = nil,
        listId: String? = nil,
        listName: String? = nil)
    {
        self.title = title
        self.dueISO = dueISO
        self.notes = notes
        self.listId = listId
        self.listName = listName
    }
}

public struct FirstClawReminderPayload: Codable, Sendable, Equatable {
    public var identifier: String
    public var title: String
    public var dueISO: String?
    public var completed: Bool
    public var listName: String?

    public init(
        identifier: String,
        title: String,
        dueISO: String? = nil,
        completed: Bool,
        listName: String? = nil)
    {
        self.identifier = identifier
        self.title = title
        self.dueISO = dueISO
        self.completed = completed
        self.listName = listName
    }
}

public struct FirstClawRemindersListPayload: Codable, Sendable, Equatable {
    public var reminders: [FirstClawReminderPayload]

    public init(reminders: [FirstClawReminderPayload]) {
        self.reminders = reminders
    }
}

public struct FirstClawRemindersAddPayload: Codable, Sendable, Equatable {
    public var reminder: FirstClawReminderPayload

    public init(reminder: FirstClawReminderPayload) {
        self.reminder = reminder
    }
}
