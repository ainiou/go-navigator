package store

import (
	"sync"

	"example.com/goapp/internal/domain"
)

// MemoryRepo 基于内存实现 domain.Repository。
type MemoryRepo struct {
	mu    sync.Mutex
	items map[int]*domain.User
	next  int
}

func NewMemoryRepo() *MemoryRepo {
	return &MemoryRepo{items: map[int]*domain.User{}}
}

func (r *MemoryRepo) Get(id int) (*domain.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	user, ok := r.items[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return user, nil
}

func (r *MemoryRepo) Save(u *domain.User) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if u.ID == 0 {
		r.next++
		u.ID = r.next
	}
	r.items[u.ID] = u
	return nil
}

// AuditRepo 通过内嵌 *MemoryRepo 复用 Get/Save，因此同样实现了 Repository。
type AuditRepo struct {
	*MemoryRepo
}

func (r *AuditRepo) Close() error {
	return nil
}
