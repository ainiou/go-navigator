package domain

import "errors"

var ErrNotFound = errors.New("user not found")

// User 是示例领域对象。
type User struct {
	ID   int
	Name string
}

func (u *User) DisplayName() string {
	if u.Name == "" {
		return "anonymous"
	}
	return u.Name
}

func (u *User) SetName(name string) {
	u.Name = name
}

// Reader 只读仓储接口。
type Reader interface {
	Get(id int) (*User, error)
}

// Repository 通过内嵌 Reader 组合读与写能力。
type Repository interface {
	Reader
	Save(u *User) error
}

// Service 应用服务接口。
type Service interface {
	Register(name string) (*User, error)
	Lookup(id int) (*User, string, error)
}

func NewUser(id int, name string) *User {
	return &User{ID: id, Name: name}
}
