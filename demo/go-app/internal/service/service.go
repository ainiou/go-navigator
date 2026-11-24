package service

import "example.com/goapp/internal/domain"

// UserService 实现 domain.Service。
type UserService struct {
	repo domain.Repository
	seq  int
}

func NewUserService(repo domain.Repository) *UserService {
	return &UserService{repo: repo}
}

func (s *UserService) Register(name string) (*domain.User, error) {
	s.seq++
	user := domain.NewUser(s.seq, name)
	if err := s.repo.Save(user); err != nil {
		return nil, err
	}
	return user, nil
}

func (s *UserService) Lookup(id int) (*domain.User, string, error) {
	user, err := s.repo.Get(id)
	if err != nil {
		return nil, "", err
	}
	return user, user.DisplayName(), nil
}
