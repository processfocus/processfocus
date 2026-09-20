import { graphql } from "@/lib/generated/gql"

// Combined query for fetching both org levels and structure
// Uses fragments to handle recursive structure up to 10 levels deep
export const orgChartDataQuery = graphql(`
  query OrgChartData {
    orgLevels {
      level
      maxDepth
    }
    org {
      id
      name
      level
      subunits {
        id
        name
        level
        subunits {
          id
          name
          level
          subunits {
            id
            name
            level
            subunits {
              id
              name
              level
              subunits {
                id
                name
                level
                subunits {
                  id
                  name
                  level
                  subunits {
                    id
                    name
                    level
                    subunits {
                      id
                      name
                      level
                      subunits {
                        id
                        name
                        level
                        subunits {
                          id
                          name
                          level
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`)
