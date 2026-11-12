package domain

// ProjectFilter narrows the project list.
type ProjectFilter struct {
	// Status limits the list to one status; nil means any.
	Status *ProjectStatus
	// Query is a case-insensitive title substring; empty means no filter.
	Query string
}

// Contributor is a user who worked in a project, shown as an avatar on its card.
type Contributor struct {
	ID          string
	DisplayName string
	Color       string
	// AvatarSHA is the hash of the stored avatar; empty when the user has none.
	AvatarSHA string
	// LastRowID is the participant row this user edited last; empty when none remains.
	LastRowID string
}

// ProjectDetails holds the data of a project that lives outside the projects table.
type ProjectDetails struct {
	Contributors []Contributor
	// Online lists the users connected to the project right now; it is live data from the
	// realtime hub, not stored.
	Online           []Peer
	ParticipantCount int
}
