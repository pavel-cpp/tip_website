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
}

// ProjectDetails holds the data of a project that lives outside the projects table.
type ProjectDetails struct {
	Contributors     []Contributor
	ParticipantCount int
}
