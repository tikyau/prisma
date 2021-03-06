package com.prisma.deploy.connector.mongo.impl.mutactions

import com.prisma.deploy.connector._
import com.prisma.deploy.connector.mongo.database.MongoDeployDatabaseMutationBuilder

object CreateProjectInterpreter extends MongoMutactionInterpreter[CreateProject] {
  override def execute(mutaction: CreateProject) = {
    MongoDeployDatabaseMutationBuilder.createClientDatabaseForProject(projectId = mutaction.projectId)
  }

  override def rollback(mutaction: CreateProject) = {
    MongoDeployDatabaseMutationBuilder.deleteProjectDatabase(projectId = mutaction.projectId)
  }
}

object TruncateProjectInterpreter extends MongoMutactionInterpreter[TruncateProject] {
  override def execute(mutaction: TruncateProject) = {
    MongoDeployDatabaseMutationBuilder.truncateProjectTables(project = mutaction.project)
  }

  override def rollback(mutaction: TruncateProject) = {
    ???
  }
}

object DeleteProjectInterpreter extends MongoMutactionInterpreter[DeleteProject] {
  override def execute(mutaction: DeleteProject) = {
    MongoDeployDatabaseMutationBuilder.deleteProjectDatabase(projectId = mutaction.projectId)
  }

  override def rollback(mutaction: DeleteProject) = {
    MongoDeployDatabaseMutationBuilder.createClientDatabaseForProject(projectId = mutaction.projectId)
  }
}
