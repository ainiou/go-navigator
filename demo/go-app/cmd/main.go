package main

import (
	"fmt"

	"example.com/goapp/internal/domain"
	"example.com/goapp/internal/service"
	"example.com/goapp/internal/store"
)

func main() {
	var repo domain.Repository = store.NewMemoryRepo()
	svc := service.NewUserService(repo)

	user, err := svc.Register("Ada")
	if err != nil {
		panic(err)
	}
	user.SetName("Ada Lovelace")
	fmt.Println(user.DisplayName())

	audit := &store.AuditRepo{MemoryRepo: store.NewMemoryRepo()}
	run(audit)
}

func run(repo domain.Repository) {
	_, _ = repo.Get(1)
	if err := repo.Save(domain.NewUser(0, "Grace")); err != nil {
		fmt.Println(err)
	}
}
